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
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
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
const sessionDirs = new Map();
let firstStdoutAt = null;
let firstStderrAt = null;
let sessionIdSeenAt = null;
let promptSentAt = null;
let childExitedAt = null;
const stdoutFile = join(OUT, `stdout-${tag}.log`);
const stderrFile = join(OUT, `stderr-${tag}.log`);
const resultFile = join(OUT, `result-${tag}.json`);

mkdirSync(OUT, { recursive: true });
// 每次运行都从空日志开始：输出文件按 tag 固定，若沿用旧内容会把上次的字节当成新输出。
writeFileSync(stdoutFile, '');
writeFileSync(stderrFile, '');

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
  for (const name of readdirSync(root)) sessionDirs.set(name, 'pre-existing');
  const observeDir = (name) => {
    if (sessionDirs.has(name)) return;
    let files = [];
    try {
      files = readdirSync(join(root, name));
    } catch { /* 目录刚创建，忽略 */ }
    sessionDirs.set(name, files.length === 0 ? 'empty' : `files:${files.join(',')}`);
    mark('session-dir-observed', {
      slug: slugOf(name),
      files,
      dirBirthSinceStart: sinceStart(statSync(join(root, name)).birthtimeMs),
    });
  };
  // 目录创建事件优先用 fs.watch，避免轮询抖动错过窗口；另保留 5ms 兜底扫描。
  const watcher = watch(root, { persistent: true }, (_event, fileName) => {
    if (typeof fileName === 'string' && fileName !== '') observeDir(fileName);
  });
  const seenSizes = new Map();
  const tick = setInterval(() => {
    for (const name of readdirSync(root)) observeDir(name);
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
    }
  }, 5);
  return () => {
    watcher.close();
    clearInterval(tick);
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
    return { unparsable: line.slice(0, 60) };
  }
}

async function runOverlay() {
  const env = { ...process.env, DSH_HOME, DSH_BIN, DSH_TASK: task, DSH_RESULT_FILE: resultFile };
  // 父进程自身可能带着工作中的 DSH_SESSION_ID／DSH_SHELL／DSH_WEB_URL，不能泄漏给被测调用。
  delete env.DSH_SESSION_ID;
  delete env.DSH_SHELL;
  delete env.DSH_WEB_URL;
  if (process.env.PROBE_SESSION_ID) env.DSH_SESSION_ID = process.env.PROBE_SESSION_ID;
  if (process.env.PROBE_DEBUG_RUNNER) env.DSH_DEBUG_RUNNER = process.env.PROBE_DEBUG_RUNNER;
  mark('parent-prepared');
  spawnChild(['--profile', 'headless', '--patch', join(REPO, 'scripts', 'headless-session', 'overlay.yml')], env);
  await waitExit();
  for (const line of stdoutLines()) mark('stdout-result-line', resultOf(line));
  if (process.env.PROBE_RESULT_FILE !== undefined) {
    try {
      const info = statSync(resultFile);
      mark('result-file-size', { size: info.size, mtime: sinceStart(info.mtimeMs) });
    } catch { /* 没写出来 */ }
  }
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
  // 充当 stdin，但普通文件每次 read 都从偏移 0 开始、会把已写内容重放，所以只发送
  // 「不依赖任何响应」的两条请求：initialize 与 session/new。
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

const stopObserving = startObservers();

try {
  if (mode === 'overlay') await runOverlay();
  else if (mode === 'official') await runOfficial();
  else if (mode === 'acp-new-only') await runAcp();
  else throw new Error(`unknown mode: ${mode}`);
} catch (error) {
  mark('probe-error', { message: String(error.message).slice(0, 300) });
  if (child && childExitedAt === null) child.kill('SIGKILL');
} finally {
  stopObserving();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const sessions = [...sessionDirs.entries()].map(([slug, state]) => {
    const sessionId = state.startsWith('files:') ? state.slice('files:'.length) : null;
    return {
      slug: slugOf(slug),
      state: state.startsWith('files:') ? 'session-file-present' : state,
      header: sessionId === null ? null : readSessionHeader(slug, sessionId),
    };
  });
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
    promptSentAt,
    childExitedAt,
    sessions,
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
    childExitedAt,
    events: events.map((event) => `${event.name}@${event.at}`),
  }, null, 2));
}
