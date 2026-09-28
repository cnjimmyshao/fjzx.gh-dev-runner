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
// 代替管道，代价是两条请求必须预写、请求顺序不受控。
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

/** birthtime 不可用时保留 null，让报告能区分「不可用」与真实的 0ms。 */
function sinceStartOrNull(epochMs) {
  return epochMs === null ? null : sinceStart(epochMs);
}

/** --C-Users-x-Temp-y-- → …-Temp-y，避免把完整本机路径写进报告。 */
function slugOf(dirName) {
  const parts = dirName.replace(/^--/, '').replace(/--$/, '').split('-');
  return `dir:…-${parts.slice(-2).join('-')}`;
}

function maskId(id) {
  return typeof id === 'string' && id.length > 12 ? `${id.slice(0, 12)}…` : (id ?? null);
}

/** 会话目录下的一级子目录就是会话标识；目录不可读时返回空列表。 */function listSessionIds(root, slug) {
  try {
    return readdirSync(join(root, slug), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * 会话头里的 createdAt 是「会话被创建」的权威时刻，比目录轮询更精确。
 * birthtime 在部分文件系统上不可用（可能为 0），此时不把它当成时刻。
 */
function safeBirthtimeMs(path) {
  try {
    const value = statSync(path).birthtimeMs;
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function readSessionHeader(slug, sessionId) {
  try {
    const file = join(DSH_HOME, 'sessions', slug, sessionId, 'session.v3.jsonl.zstd');
    const header = JSON.parse(zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n')[0]);
    return {
      createdAt: header.createdAt,
      createdAtSinceStart: sinceStart(header.createdAt),
      fileBirthSinceStart: sinceStartOrNull(safeBirthtimeMs(file)),
      fileWriteSinceStart: sinceStart(statSync(file).mtimeMs),
      dirMatchesId: header.id === sessionId,
    };
  } catch {
    return null;
  }
}

function startObservers() {
  const root = join(DSH_HOME, 'sessions');
  mkdirSync(root, { recursive: true });
  // 一级目录是工作目录 slug，新会话是它下面新出现的 session 子目录。启动时（spawn 之前）
  // 先快照一次：快照里已有的 slug 与会话就是「上一次运行留下的」，不再靠创建时刻或时序
  // 猜测——文件系统给不出可靠 birthtime 时，那些推断会把本轮新会话误判成旧会话。
  const knownSlugs = new Set(readdirSync(root));
  const knownSessions = new Map();
  for (const slug of knownSlugs) knownSessions.set(slug, new Set(listSessionIds(root, slug)));
  const observeSlug = (slug) => {
    if (knownSlugs.has(slug)) return;
    knownSlugs.add(slug);
    knownSessions.set(slug, new Set());
    mark('session-slug-created', { slug: slugOf(slug) });
  };
  const observeSession = (slug, sessionId) => {
    const known = knownSessions.get(slug) ?? new Set();
    if (known.has(sessionId)) {
      // 已经见过的会话：目录先出现、会话文件后写完时，补读上一次还读不到的会话头。
      const event = events.find((item) => item.name === 'session-created' && item.header === null
        && item.sessionId === maskId(sessionId) && item.slug === slugOf(slug));
      if (event !== undefined) event.header = readSessionHeader(slug, sessionId);
      return;
    }
    known.add(sessionId);
    knownSessions.set(slug, known);
    const dir = join(root, slug, sessionId);
    let files = [];
    try {
      files = readdirSync(dir);
    } catch { /* 目录刚创建，忽略 */ }
    mark('session-created', {
      slug: slugOf(slug),
      sessionId: maskId(sessionId),
      files,
      dirBirthSinceStart: sinceStartOrNull(safeBirthtimeMs(dir)),
      header: readSessionHeader(slug, sessionId),
    });
  };
  const scanSessions = () => {
    for (const slug of readdirSync(root)) {
      observeSlug(slug);
      for (const sessionId of listSessionIds(root, slug)) observeSession(slug, sessionId);
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
  launched.on('error', (error) => {
    // error.message 常带 Node 可执行文件或工作目录的绝对路径，报告里只留错误码。
    mark('child-spawn-error', { code: error.code ?? null, stage: 'spawn' });
    // spawn 失败不会有 exit 事件；不在这里结算，waitExit() 会一直等到超时。
    if (childExitedAt === null) {
      childExitedAt = Date.now() - t0;
      exitCode = null;
    }
  });
  launched.on('exit', (code) => {
    childExitedAt = Date.now() - t0;
    exitCode = code;
    mark('child-exit', { code });
  });
  launched.on('close', (code) => {
    if (childExitedAt === null) childExitedAt = Date.now() - t0;
    if (exitCode === null && typeof code === 'number') exitCode = code;
  });
  return launched;
}

function waitExit() {
  return new Promise((resolve) => {
    if (child === null || childExitedAt !== null) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setTimeout(resolve, 40);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      mark('probe-timeout', { timeoutMs });
      child.kill('SIGKILL');
      // 子进程可能根本没起来（spawn 失败）或杀不掉，不能只等事件。
      if (childExitedAt === null) childExitedAt = Date.now() - t0;
      finish();
    }, timeoutMs);
    // exit 在 spawn 失败时不会触发，close 一定会；两者都结算。
    child.on('exit', finish);
    child.on('close', finish);
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

/** stdout 增长时立刻解析，取 sessionId 首次可见的时刻（而不是等子进程退出后再读）。
 *  只在 overlay 模式解析：只有它承诺 stdout 是 result JSON；official 的 stdout 是模型
 *  正文，若正文里恰好出现 `sessionId` 字段，会被误当成 CLI 交付的标识。 */
function observeResultLine() {
  if (mode !== 'overlay') return;
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
  // 沙箱不允许管道：既不能 pipe 捕获输出，也不能用命名管道做 stdin，只能把两条请求
  // 预写进普通文件，由子进程以文件读句柄读取。因此**请求顺序不受控**：`session/new`
  // 与 `initialize` 同时可读，可能在 initialize 完成前就被处理，这一点与仓库里逐条
  // 交互的 acp-session-probe.mjs 不同。本模式只能用于观察「只做 session/new 时是否
  // 立刻拿到 id」，结论里必须保留这个未受控变量。
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
        // JSON-RPC 错误消息可能回显 cwd 等绝对路径；只记结构化字段与长度。
        const detail = JSON.stringify(message.error);
        mark('acp-error', {
          id: message.id,
          code: message.error?.code ?? null,
          hasPathLikeText: /[A-Za-z]:\\|\//.test(String(message.error?.message ?? '')),
          detailBytes: detail.length,
        });
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
  // 子进程可能在上一次轮询之后写出响应并立即退出；判定「未观察到」之前再读一次。
  drain();
  if (sessionId === null) {
    mark('sessionId-not-observed', { reason: Date.now() >= deadline ? 'deadline' : 'child-exit' });
    if (Date.now() >= deadline && !timedOut) {
      // 子进程一直活着但没在时限内给出标识：这是探针自己的超时，要如实结算。
      timedOut = true;
      mark('probe-timeout', { timeoutMs, stage: 'acp-session-new' });
    }
  }
  clearInterval(tick);
  // 会话若存在，在 session/new 阶段就已创建并落盘；本轮不再投递 prompt，直接结束子进程。
  if (childExitedAt === null) {
    launched.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => launched.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
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
  mark('probe-error', { code: error.code ?? null, name: error.name ?? null, messageBytes: String(error.message ?? '').length });
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
