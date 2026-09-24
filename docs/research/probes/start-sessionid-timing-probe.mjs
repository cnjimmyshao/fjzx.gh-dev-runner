// Issue #33 时序探针：实测 START 时 sessionId 的创建与可见时点。
//
// 这是 Research 证据的最小复现件（见 docs/research/2026-09-24-start-sessionid-visibility.md），
// 不是接单工具的运行代码，也不属于任何被接入项目的业务代码。
//
// 实测的两条时间来源：
//   - 会话创建时刻：<DSH_HOME>\sessions\<工作目录 slug>\<sessionId>\ 目录出现，以及会话头
//     `session.v3.jsonl.zstd` 里 `createdAt`（毫秒 epoch）——两者相差约 30ms；
//   - 调用方可见时刻：子进程 stdout／stderr 首次出现字节（按文件 mtime 取），
//     以及 stdout 里的 result JSON 是否已经带 sessionId。
//
// 实现约束：本机沙箱禁止父进程用管道捕获子进程输出（spawn EPERM），因此子进程的
// stdout／stderr 接到父进程预先打开的普通文件句柄；ACP 模式的 stdin 同样用普通文件
// 代替管道（句柄偏移留在 0，父进程以追加方式写入请求行）。
//
// 用法（PowerShell）：
//   $env:DSH_HOME  = '<独立测试 home>'
//   $env:DSH_BIN   = '<dsh 启动器入口，即 @deepseek-ai/dsh 的 lib/bin.js>'
//   $env:PROBE_REPO = '<本仓库>'
//   $env:PROBE_OUT  = '<独立输出目录>'
//   node start-sessionid-timing-probe.mjs <mode> <绝对工作目录> [任务文本文件]
//
// mode：
//   overlay        本地 overlay runner（DSH_TASK／DSH_SESSION_ID／DSH_RESULT_FILE）
//   official       官方 headless（本机 0.1.5-rc.2 只有 [task...]）
//   acp-new-only   acp profile，只 initialize + session/new，不投递 prompt
//
// 环境变量（可选）：PROBE_SESSION_ID 续接标识、PROBE_DEBUG_RUNNER 打开 runner 调试行、
// PROBE_TAG 输出文件名后缀、PROBE_TIMEOUT_MS 子进程超时（默认 180000）。
// 输出：<PROBE_OUT>/report-<tag>.json，只含时序与键名，不含模型正文、凭据与本机绝对路径。

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const [mode, cwd, taskFile] = process.argv.slice(2);
const DSH_BIN = process.env.DSH_BIN;
const DSH_HOME = process.env.DSH_HOME;
const REPO = process.env.PROBE_REPO;
const OUT = process.env.PROBE_OUT;
if (!mode || !cwd || !DSH_BIN || !DSH_HOME || !REPO || !OUT) {
  console.error('usage: DSH_BIN=.. DSH_HOME=.. PROBE_REPO=.. PROBE_OUT=.. node start-sessionid-timing-probe.mjs <mode> <cwd> [taskFile]');
  process.exit(2);
}
const task = taskFile === undefined ? '' : readFileSync(taskFile, 'utf8');
const tag = process.env.PROBE_TAG ?? mode;
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 180000);

const events = [];
let t0 = null;
let child = null;
let exitCode = null;
let timedOut = false;
let firstStdoutAt = null;
let firstStderrAt = null;
let sessionIdSeenAt = null;
let resultFileSeenAt = null;
let resultFileParsedAt = null;
let childExitedAt = null;
const stdoutFile = join(OUT, `stdout-${tag}.log`);
const stderrFile = join(OUT, `stderr-${tag}.log`);
const resultFile = join(OUT, `result-${tag}.json`);
const resultFileExpected = mode === 'overlay';

mkdirSync(OUT, { recursive: true });
// 每次运行都从空输出开始：文件名按 tag 固定，沿用旧内容会把上次的字节或上次的 result
// 当成新输出（本轮若在写结果前失败、超时或被强杀，旧 result 会一直留在原地）。
writeFileSync(stdoutFile, '');
writeFileSync(stderrFile, '');
rmSync(resultFile, { force: true });

function mark(name, extra = {}) {
  events.push({ name, at: t0 === null ? null : Date.now() - t0, ...extra });
}

function sinceStart(epochMs) {
  return t0 === null ? null : Math.round(epochMs - t0);
}

/** --C-Users-x-Temp-y-- → …-Temp-y，避免把完整本机路径写进报告。 */
function slugOf(dirName) {
  const parts = dirName.replace(/^--/, '').replace(/--$/, '').split('-');
  return `dir:…-${parts.slice(-2).join('-')}`;
}

function maskId(id) {
  return typeof id === 'string' && id.length > 12 ? `${id.slice(0, 12)}…` : (id ?? null);
}

/** 会话头里的 createdAt 是「会话被创建」的权威时刻，比目录轮询更精确。 */
function readSessionHeader(slug, sessionId) {
  try {
    const file = join(DSH_HOME, 'sessions', slug, sessionId, 'session.v3.jsonl.zstd');
    const header = JSON.parse(zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n')[0]);
    const info = statSync(file);
    return {
      createdAt: header.createdAt,
      createdAtSinceStart: sinceStart(header.createdAt),
      fileBirthSinceStart: sinceStart(info.birthtimeMs),
      fileWriteSinceStart: sinceStart(info.mtimeMs),
      dirMatchesId: header.id === sessionId,
    };
  } catch {
    return null;
  }
}

function startObservers() {
  const root = join(DSH_HOME, 'sessions');
  mkdirSync(root, { recursive: true });
  // 一级目录是工作目录 slug，新会话是它下面新出现的 session 子目录；两者分别快照，
  // 这样同一个 DSH_HOME + 工作目录连续跑多次也能逐次读到新建会话。
  const knownSlugs = new Set(readdirSync(root));
  const knownSessions = new Map();
  // 之前几次运行留下的会话目录会在第一次扫描时就被看到，不能当成「本轮创建」：
  // 记下它们的目录与文件创建时刻，只有落在本轮启动之后的才算本轮的新建会话。
  const pending = new Map();
  const notePendingIfOld = (slug, sessionId) => {
    const dir = join(root, slug, sessionId);
    let dirBirth = null;
    let fileBirth = null;
    try {
      dirBirth = statSync(dir).birthtimeMs;
      const file = join(dir, 'session.v3.jsonl.zstd');
      fileBirth = statSync(file).birthtimeMs;
    } catch { /* 还没写出来 */ }
    if (dirBirth !== null && dirBirth < t0) pending.set(`${slug}/${sessionId}`, 'pre-existing');
    else if (fileBirth !== null && fileBirth < t0) pending.set(`${slug}/${sessionId}`, 'pre-existing');
  };
  for (const slug of knownSlugs) {
    for (const sessionId of readdirSync(join(root, slug), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)) notePendingIfOld(slug, sessionId);
  }
  const snapshotSessions = (slug) => {
    try {
      return new Set(readdirSync(join(root, slug), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name));
    } catch {
      return new Set();
    }
  };
  const observeSlug = (slug) => {
    if (knownSlugs.has(slug)) return;
    knownSlugs.add(slug);
    knownSessions.set(slug, snapshotSessions(slug));
    mark('session-slug-created', { slug: slugOf(slug) });
  };
  const headerOf = (slug, sessionId) => `${slug}/${sessionId}`;
  const observeSession = (slug, sessionId) => {
    const known = knownSessions.get(slug) ?? new Set();
    if (known.has(sessionId)) {
      // 目录先出现、会话文件后写完：补读上一次还读不到的会话头。
      const event = events.find((item) => item.name === 'session-created' && item.header === null
        && item.sessionId === maskId(sessionId) && item.slug === slugOf(slug));
      if (event !== undefined) event.header = readSessionHeader(slug, sessionId);
      return;
    }
    known.add(sessionId);
    knownSessions.set(slug, known);
    notePendingIfOld(slug, sessionId);
    if (pending.get(headerOf(slug, sessionId)) === 'pre-existing') return;
    const dir = join(root, slug, sessionId);
    let dirBirthSinceStart = null;
    let files = [];
    try {
      files = readdirSync(dir);
      dirBirthSinceStart = sinceStart(statSync(dir).birthtimeMs);
    } catch { /* 目录刚创建，忽略 */ }
    mark('session-created', {
      slug: slugOf(slug),
      sessionId: maskId(sessionId),
      files,
      dirBirthSinceStart,
      header: readSessionHeader(slug, sessionId),
    });
  };
  const scanSessions = () => {
    for (const slug of readdirSync(root)) {
      observeSlug(slug);
      for (const sessionId of snapshotSessions(slug)) observeSession(slug, sessionId);
    }
  };
  // 目录创建事件优先用 fs.watch，避免轮询抖动错过窗口；另保留 5ms 兜底扫描。
  const watcher = watch(root, { persistent: true }, (_event, fileName) => {
    if (typeof fileName === 'string' && fileName !== '') {
      try {
        observeSlug(fileName);
        scanSessions();
      } catch { /* 目录刚创建，忽略 */ }
    }
  });
  const seenSizes = new Map();
  let ticking = false;
  const tick = setInterval(() => {
    if (ticking) return;
    ticking = true;
    try {
      scanSessions();
      for (const [path, label] of [[stdoutFile, 'stdout'], [stderrFile, 'stderr']]) {
        let size = 0;
        let mtime = null;
        try {
          const info = statSync(path);
          size = info.size;
          mtime = sinceStart(info.mtimeMs);
        } catch {
          continue;
        }
        const previous = seenSizes.get(path) ?? 0;
        if (size === previous) continue;
        seenSizes.set(path, size);
        if (previous === 0 && size > 0) {
          if (label === 'stdout') firstStdoutAt = Date.now() - t0;
          else firstStderrAt = Date.now() - t0;
          mark(`first-${label}-visible`, { mtime });
        }
        if (label === 'stdout' && sessionIdSeenAt === null) observeResultLine();
      }
      observeResultJson();
    } finally {
      ticking = false;
    }
  }, 5);
  return {
    stop: () => {
      watcher.close();
      clearInterval(tick);
    },
    // 收尾补扫：会话目录可能在最后一次 tick 之后才出现（例如 turn 很快就结束）。
    scan: scanSessions,
  };
}

function spawnChild(args, env, extra) {
  const outFd = openSync(stdoutFile, 'a');
  const errFd = openSync(stderrFile, 'a');
  t0 = Date.now();
  const launched = spawn(process.execPath, [DSH_BIN, ...args], {
    cwd,
    stdio: [extra?.stdinFd ?? 'ignore', outFd, errFd],
    env,
  });
  child = launched;
  mark('spawn-called', { pid: launched.pid });
  launched.on('error', (error) => mark('child-spawn-error', { message: String(error.message).slice(0, 200) }));
  launched.on('exit', (code) => {
    childExitedAt = Date.now() - t0;
    exitCode = code;
    mark('child-exit', { code });
  });
  return launched;
}

function waitExit() {
  return new Promise((resolve) => {
    if (child === null || childExitedAt !== null) return resolve();
    const timer = setTimeout(() => {
      timedOut = true;
      mark('probe-timeout', { timeoutMs });
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      setTimeout(resolve, 40);
    });
  });
}

function stdoutLines() {
  try {
    return readFileSync(stdoutFile, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function resultOf(line) {
  try {
    const parsed = JSON.parse(line);
    return {
      sessionId: maskId(parsed.sessionId),
      continueReason: parsed.continueReason ?? null,
      statusKind: parsed.status?.kind ?? null,
      textBytes: typeof parsed.text === 'string' ? parsed.text.length : null,
    };
  } catch {
    // 不把无法解析的原文写进报告：它可能是模型正文、任务内容或本机路径。
    // 原文仍留在 <PROBE_OUT>/stdout-<tag>.log 的独立本机日志里。
    return { unparsableBytes: line.length };
  }
}

/** stdout 增长时立刻解析，取 sessionId 首次可见的时刻（而不是等子进程退出后再读）。 */
function observeResultLine() {
  for (const line of stdoutLines()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed.sessionId !== 'string' || parsed.sessionId === '') continue;
    sessionIdSeenAt = Date.now() - t0;
    mark('sessionId-visible-in-stdout', resultOf(line));
    return;
  }
}

/** overlay 模式一定设置 DSH_RESULT_FILE，因此无条件记录该文件何时出现、何时可解析。 */
function observeResultJson() {
  if (!resultFileExpected || resultFileParsedAt !== null) return;
  let size = 0;
  let mtime = null;
  try {
    const info = statSync(resultFile);
    size = info.size;
    mtime = sinceStart(info.mtimeMs);
  } catch {
    return;
  }
  if (size === 0) return;
  if (resultFileSeenAt === null) {
    resultFileSeenAt = Date.now() - t0;
    mark('result-file-visible', { size, mtime });
  }
  try {
    JSON.parse(readFileSync(resultFile, 'utf8'));
    resultFileParsedAt = Date.now() - t0;
    mark('result-file-parsable', { size, mtime });
  } catch { /* 还没写完 */ }
}

async function runOverlay() {
  const env = { ...process.env, DSH_HOME, DSH_BIN, DSH_TASK: task, DSH_RESULT_FILE: resultFile };
  // 父进程自身可能带着工作中的 DSH_SESSION_ID／DSH_SHELL／DSH_WEB_URL／DSH_DEBUG_RUNNER，
  // 全部不能泄漏给被测调用：调试行会污染「未开调试时 stderr 为空」这类结论。
  delete env.DSH_SESSION_ID;
  delete env.DSH_SHELL;
  delete env.DSH_WEB_URL;
  delete env.DSH_DEBUG_RUNNER;
  if (process.env.PROBE_SESSION_ID) env.DSH_SESSION_ID = process.env.PROBE_SESSION_ID;
  if (process.env.PROBE_DEBUG_RUNNER) env.DSH_DEBUG_RUNNER = process.env.PROBE_DEBUG_RUNNER;
  mark('parent-prepared');
  spawnChild(['--profile', 'headless', '--patch', join(REPO, 'scripts', 'headless-session', 'overlay.yml')], env);
  await waitExit();
  for (const line of stdoutLines()) mark('stdout-result-line', resultOf(line));
}

async function runOfficial() {
  mark('parent-prepared');
  spawnChild(['--profile', 'headless', task], { ...process.env, DSH_HOME });
  await waitExit();
  mark('stdout-final-lines', { lines: stdoutLines().length, textBytes: stdoutLines().join('').length });
}

async function runAcp() {
  const inFile = join(OUT, `stdin-${tag}.log`);
  // 沙箱不允许管道：既不能 pipe 捕获输出，也不能用命名管道做 stdin。这里用普通文件
  // 充当 stdin，只能预先把两条请求一次写好（普通文件每次 read 都从偏移 0 开始，会在
  // 已写内容上重放，无法按响应逐条追加）。因此**请求顺序不受控**：session/new 可能在
  // initialize 尚未完成时到达，这一点与仓库里逐条交互的 acp-session-probe.mjs 不同，
  // 结论里必须保留为未受控的实验变量，不能只归因于「没有管道」。
  writeFileSync(inFile, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } },
  ].map((message) => `${JSON.stringify(message)}\n`).join(''));
  const inFd = openSync(inFile, 'r');
  mark('parent-prepared');
  const launched = spawnChild(['--profile', 'acp'], { ...process.env, DSH_HOME }, { stdinFd: inFd });
  const handledIds = new Set();
  let sessionId = null;
  const drain = () => {
    for (const line of stdoutLines()) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined || message.method !== undefined) continue;
      // 普通文件 stdin 会重放请求，同 id 的响应可能重复；只记第一次。
      if (handledIds.has(message.id)) continue;
      handledIds.add(message.id);
      if (message.error !== undefined) {
        mark('acp-error', { id: message.id, message: JSON.stringify(message.error).slice(0, 160) });
        continue;
      }
      if (message.id === 1) mark('acp-initialized');
      if (message.id === 2) {
        sessionId = message.result?.sessionId ?? null;
        sessionIdSeenAt = Date.now() - t0;
        mark('caller-received-sessionId', { sessionId: maskId(sessionId) });
      }
    }
  };
  const tick = setInterval(drain, 5);
  const deadline = Date.now() + timeoutMs;
  while (sessionId === null && Date.now() < deadline && childExitedAt === null) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (sessionId === null) mark('sessionId-not-observed');
  clearInterval(tick);
  // 会话在 session/new 阶段就已创建并落盘；本轮不再投递 prompt，直接结束子进程。
  if (childExitedAt === null) {
    launched.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  closeSync(inFd);
  await waitExit();
}

const observers = startObservers();

try {
  if (mode === 'overlay') await runOverlay();
  else if (mode === 'official') await runOfficial();
  else if (mode === 'acp-new-only') await runAcp();
  else throw new Error(`unknown mode: ${mode}`);
} catch (error) {
  mark('probe-error', { message: String(error.message).slice(0, 300) });
  if (child && childExitedAt === null) child.kill('SIGKILL');
} finally {
  await new Promise((resolve) => setTimeout(resolve, 60));
  observers.scan();
  observers.stop();
  const report = {
    mode,
    tag,
    taskBytes: task.length,
    startedAtEpoch: t0,
    exitCode,
    timedOut,
    firstStdoutAt,
    firstStderrAt,
    sessionIdSeenAt,
    resultFileSeenAt,
    resultFileParsedAt,
    childExitedAt,
    events,
  };
  writeFileSync(join(OUT, `report-${tag}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    mode,
    tag,
    exitCode,
    timedOut,
    firstStdoutAt,
    firstStderrAt,
    sessionIdSeenAt,
    resultFileSeenAt,
    childExitedAt,
    events: events.map((event) => `${event.name}@${event.at}`),
  }, null, 2));
}
