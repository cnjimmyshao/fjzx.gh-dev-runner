/**
 * Harness 调用：官方 headless profile 的 START / RESUME，以及 `--json` 事件流的解析与判读。
 *
 * 本机实测调用路径（docs/research/2026-09-29-shared-dsh-home-concurrency.md）：
 *   <node> <dsh>/lib/bin.js --profile headless --json [--session-id <id>]
 * 任务正文通过 stdin 交给子进程，不拼 shell；`--json` 流以 `session` 事件开头，以 `final` 结束。
 *
 * 子进程 stdout / stderr 直接重定向到本机文件，而不是由 Runner 持有管道：
 * Runner 崩溃或重启时旧 Harness 仍能继续写入并继续运行，重启后可以按文件证据恢复判读。
 *
 * 判读原则（docs/current/03-runner-trigger.md、05-harness-scheduling.md）：
 * - 退出码 0 只代表本机技术调用完成，不等于业务完成；
 * - 同 session 第二写入者被 Harness 自身锁拒绝时属于“未启动 / 未写入”，不是正常完成；
 * - session 身份、cwd、preset 不匹配不自行兜底新建。
 */

import { execFile, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** 允许继承给 Harness 子进程的最小系统环境；凭据类变量只能通过显式 allowlist 透传。 */
const SYSTEM_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TZ',
  // 非 token 的凭据/agent 定位变量：保持父进程与 Harness 内 gh/git 的认证位置一致。
  'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'SSH_AUTH_SOCK',
];

/** 事件流轮询间隔：只用于尽早取得 sessionId 与早期判据，不影响子进程执行。 */
const TAIL_INTERVAL_MS = 150;

/** capture=metadata 时长期保留的技术事件类型。 */
const TECHNICAL_EVENT_TYPES = new Set(['session', 'status', 'final', 'error']);

/** 本机诊断分类；公开到 GitHub 的失败文字只从这些分类派生。 */
export const HARNESS_FAILURE = Object.freeze({
  spawnFailed: 'spawn_failed',
  timeout: 'timeout',
  sessionBusy: 'session_busy',
  sessionRefused: 'session_refused',
  sessionMismatch: 'session_mismatch',
  harnessError: 'harness_error',
  roundFailed: 'round_failed',
});

const SESSION_BUSY_PATTERN = /already owned by an active write handle/i;
const SESSION_REFUSED_PATTERN = /(no stored session|was recorded in|does not exist|unknown session|not found|cannot be adopted)/i;

/**
 * 组装 Harness 子进程环境：最小系统环境 + 可选 DSH_HOME + 显式 allowlist。
 * @param {{harness: {home: string|null, envAllowlist: string[]}}} config
 * @param {Record<string, string|undefined>} [parentEnv]
 */
export function buildHarnessEnv(config, parentEnv = process.env) {
  const env = {};
  for (const key of SYSTEM_ENV_KEYS) {
    if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
  }
  if (config.harness.home !== null) env.DSH_HOME = config.harness.home;
  for (const key of config.harness.envAllowlist) {
    if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
  }
  return env;
}

/**
 * 组装调用命令。`.js` 入口用当前 Node 运行（Runner 本身受 engines.node=24.x 约束）。
 * @param {{harness: {bin: string, profile: string}}} config
 * @param {string|null} sessionId
 */
export function harnessInvocation(config, sessionId) {
  const args = ['--profile', config.harness.profile, '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  if (/\.(c|m)?js$/.test(config.harness.bin)) {
    return { command: process.execPath, args: [config.harness.bin, ...args] };
  }
  return { command: config.harness.bin, args };
}

/**
 * 按偏移增量读取一个持续增长的文件，并保留被切断的多字节字符。
 * 事件流由子进程直接写入文件，父进程只能按当前长度分批读取；每批独立解码会把
 * 中文等多字节字符切成替换字符，因此这里用 StringDecoder 保留未完成的字节。
 * @param {string} file
 * @param {{onError?: (error: Error) => void}} [options]
 */
export function createFileTail(file, options = {}) {
  let offset = 0;
  const decoder = new StringDecoder('utf8');
  const onError = options.onError ?? (() => {});
  return {
    /** @returns {string} 本次新增的已解码文本 */
    read() {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        return '';
      }
      if (size <= offset) return '';
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      let fd = null;
      try {
        fd = fs.openSync(file, 'r');
        const bytes = fs.readSync(fd, buffer, 0, length, offset);
        offset += bytes;
        return decoder.write(buffer.subarray(0, bytes));
      } catch (error) {
        onError(error);
        return '';
      } finally {
        if (fd !== null) safeClose(fd);
      }
    },
    /** 读出解码器中残留的最后一个不完整字符。 */
    flush() {
      return decoder.end();
    },
    get offset() {
      return offset;
    },
  };
}

/** 逐行拆分的读取器；跨 chunk 的半行不会当成事件。 */
export function createLineReader(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== '') onLine(line);
        index = buffer.indexOf('\n');
      }
    },
    flush() {
      const rest = buffer;
      buffer = '';
      if (rest.trim() !== '') onLine(rest);
    },
  };
}

/**
 * @param {object} options
 * @param {object} options.config
 * @param {Function} [options.spawn]
 * @param {Function} [options.exec]
 * @param {object} [options.logger]
 * @param {number} [options.tailIntervalMs]
 */
export function createHarnessRunner(options) {
  const config = options.config;
  const spawnFn = options.spawn ?? nodeSpawn;
  const execFn = options.exec ?? defaultExec;
  const logger = options.logger ?? { warn: () => {}, info: () => {}, error: () => {} };
  const tailIntervalMs = options.tailIntervalMs ?? TAIL_INTERVAL_MS;

  return {
    /**
     * 启动一次 Harness 调用。调用方必须已经完成 claim 并写入 starting。
     * @param {object} input
     * @param {string} input.runId
     * @param {'start'|'resume'} input.kind
     * @param {string} input.dir
     * @param {string|null} input.sessionId
     * @param {string} input.task
     * @param {string} [input.runDir]
     */
    launch(input) {
      const runDir = input.runDir ?? runDirFor(config, input.runId);
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const stdoutPath = path.join(runDir, 'stdout.jsonl');
      const stderrPath = path.join(runDir, 'stderr.log');

      const record = {
        sessionId: null,
        sessionCwd: null,
        sessionMismatch: false,
        turnEndReason: null,
        hadAssistantCommit: false,
        hadFinal: false,
        errorMessage: null,
        invalidLines: 0,
        eventCount: 0,
      };

      let resolveSession;
      const sessionPromise = new Promise((resolve) => {
        resolveSession = resolve;
      });
      let resolveEarly;
      const earlyPromise = new Promise((resolve) => {
        resolveEarly = resolve;
      });
      let settledSession = false;
      let settledEarly = false;

      const reader = createLineReader((line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          record.invalidLines += 1;
          return;
        }
        if (event === null || typeof event !== 'object' || Array.isArray(event)) {
          record.invalidLines += 1;
          return;
        }
        record.eventCount += 1;

        switch (event.type) {
          case 'session': {
            record.sessionId = typeof event.sessionId === 'string' ? event.sessionId : null;
            record.sessionCwd = typeof event.cwd === 'string' ? event.cwd : null;
            if (input.kind === 'resume' && input.sessionId && record.sessionId !== input.sessionId) {
              record.sessionMismatch = true;
            }
            if (!settledSession) {
              settledSession = true;
              resolveSession(record.sessionId);
            }
            return;
          }
          case 'status': {
            if (event.phase === 'turn_end') record.turnEndReason = event.reason ?? null;
            return;
          }
          case 'error': {
            record.errorMessage = typeof event.message === 'string' ? event.message : 'harness error';
            return;
          }
          case 'final': {
            record.hadFinal = true;
            return;
          }
          case 'text':
          case 'thinking':
          case 'tool_call':
          case 'tool_result': {
            record.hadAssistantCommit = true;
            if (!settledEarly) {
              settledEarly = true;
              resolveEarly(true);
            }
            return;
          }
          default:
            return;
        }
      });

      const invocation = harnessInvocation(config, input.sessionId);
      let child = null;
      let spawnError = null;
      let outFd = null;
      let errFd = null;
      try {
        outFd = fs.openSync(stdoutPath, 'a', 0o600);
        errFd = fs.openSync(stderrPath, 'a', 0o600);
        child = spawnFn(invocation.command, invocation.args, {
          cwd: input.dir,
          env: buildHarnessEnv(config),
          stdio: ['pipe', outFd, errFd],
        });
      } catch (error) {
        spawnError = error;
      } finally {
        if (outFd !== null) safeClose(outFd);
        if (errFd !== null) safeClose(errFd);
      }

      const tail = createFileTail(stdoutPath, {
        onError: (error) => logger.warn(`读取事件流失败: ${error.code ?? error.message}`),
      });
      let tailTimer = null;
      let timedOut = false;
      let killTimer = null;
      let hardKillTimer = null;
      let finished = false;
      let resolveExit;
      const exitPromise = new Promise((resolve) => {
        resolveExit = resolve;
      });

      const readNewBytes = () => {
        reader.push(tail.read());
      };

      const finish = (result) => {
        if (finished) return;
        finished = true;
        if (tailTimer !== null) clearInterval(tailTimer);
        if (killTimer !== null) clearTimeout(killTimer);
        if (hardKillTimer !== null) clearTimeout(hardKillTimer);
        readNewBytes();
        reader.push(tail.flush());
        reader.flush();
        if (!settledSession) {
          settledSession = true;
          resolveSession(record.sessionId);
        }
        if (!settledEarly) {
          settledEarly = true;
          resolveEarly(false);
        }
        resolveExit({ ...record, ...result, runDir, stdoutPath, stderrPath });
      };

      if (child === null) {
        finish({ exitCode: null, signal: null, timedOut: false, spawnError: describeError(spawnError) });
        return buildHandle(null, sessionPromise, earlyPromise, exitPromise, record);
      }

      tailTimer = setInterval(readNewBytes, tailIntervalMs);
      tailTimer.unref?.();

      child.on('error', (error) => {
        spawnError = error;
      });
      child.stdin.on('error', () => {
        /* 子进程提前退出时忽略 EPIPE */
      });

      if (config.harness.timeoutMs > 0) {
        killTimer = setTimeout(() => {
          timedOut = true;
          logger.warn(`Harness 调用超过 ${config.harness.timeoutMs}ms，发送 SIGTERM`);
          try {
            child.kill('SIGTERM');
          } catch {
            /* 已退出 */
          }
          hardKillTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* 已退出 */
            }
          }, 5_000);
          hardKillTimer.unref?.();
        }, config.harness.timeoutMs);
        killTimer.unref?.();
      }

      child.on('close', (code, signal) => {
        finish({ exitCode: code, signal: signal ?? null, timedOut, spawnError: describeError(spawnError) });
      });

      try {
        child.stdin.end(input.task);
      } catch {
        /* close / error 会给出结果 */
      }

      return buildHandle(child, sessionPromise, earlyPromise, exitPromise, record);
    },

    /**
     * 重启后核对旧 Harness 是否仍在运行。无法可靠判断时返回 unknown（保守占槽）。
     * @param {number|null} pid
     * @param {string|null} signature
     * @returns {Promise<'alive'|'gone'|'reused'|'unknown'>}
     */
    async probe(pid, signature) {
      if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
      const result = await execFn('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 10_000 });
      if (result.code !== 0) {
        // 只有明确的“进程不存在”才释放槽位；超时、被杀、权限/系统错误一律 unknown 保守占槽。
        if (result.notFound === true) return 'gone';
        return 'unknown';
      }
      const current = result.stdout.trim();
      if (signature === null || signature === undefined || signature === '') return 'unknown';
      return current === signature ? 'alive' : 'reused';
    },

    /**
     * 采集可避免 PID 重用误判的附加证据（进程启动时间的原始文本，逐字比较，不解析）。
     * @param {number} pid
     */
    async readSignature(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const result = await execFn('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 10_000 });
      if (result.code !== 0) return null;
      const value = result.stdout.trim();
      return value === '' ? null : value;
    },

    /**
     * 读取已有捕获文件，用于重启后判断旧调用究竟走到哪一步。
     * @param {string} runDir
     */
    readCapture(runDir) {
      return summarizeCapture(runDir);
    },

    /**
     * 按保留策略收敛捕获文件：metadata 只留技术事实，不留模型正文。
     * @param {string} runDir
     */
    finalizeCapture(runDir) {
      if (config.runtime.capture === 'full') return;
      // metadata 只保留技术事件：stderr 可能有诊断、模型或工具输出与本机路径，默认不长期留。
      try {
        fs.rmSync(path.join(runDir, 'stderr.log'), { force: true });
      } catch (error) {
        logger.warn(`清理 stderr 捕获失败: ${error.code ?? error.message}`);
      }
      const file = path.join(runDir, 'stdout.jsonl');
      if (!fs.existsSync(file)) return;
      const kept = [];
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          const event = JSON.parse(line);
          if (!TECHNICAL_EVENT_TYPES.has(event?.type)) continue;
          // `final` 只保留“出现过终态”这一事实，不保留回答正文。
          kept.push(event.type === 'final' ? JSON.stringify({ type: 'final' }) : line);
        } catch {
          /* 半截行直接丢弃 */
        }
      }
      try {
        fs.writeFileSync(file, kept.length === 0 ? '' : `${kept.join('\n')}\n`, { mode: 0o600 });
      } catch (error) {
        logger.warn(`收敛事件流文件失败: ${error.code ?? error.message}`);
      }
    },
  };
}

/** @param {object} config @param {string} runId */
export function runDirFor(config, runId) {
  return path.join(config.runtime.stateDir, 'runs', runId);
}

/**
 * 汇总捕获文件中的技术事实（不读取模型正文）。
 * @param {string} runDir
 */
export function summarizeCapture(runDir) {
  const file = path.join(runDir, 'stdout.jsonl');
  const summary = {
    exists: false,
    sessionId: null,
    turnEndReason: null,
    hadFinal: false,
    hadAssistantCommit: false,
    errorMessage: null,
  };
  if (!fs.existsSync(file)) return summary;
  summary.exists = true;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'session' && typeof event.sessionId === 'string') summary.sessionId = event.sessionId;
    if (event.type === 'status' && event.phase === 'turn_end') summary.turnEndReason = event.reason ?? null;
    if (event.type === 'final') summary.hadFinal = true;
    if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_call' || event.type === 'tool_result') {
      summary.hadAssistantCommit = true;
    }
    if (event.type === 'error' && typeof event.message === 'string') summary.errorMessage = event.message;
  }
  return summary;
}

/**
 * 把一次调用的实际结果折算成技术判读；不产生任何业务结论。
 * @param {object} result
 */
export function classifyHarnessResult(result) {
  if (result.spawnError) return { ok: false, category: HARNESS_FAILURE.spawnFailed };
  if (result.timedOut) return { ok: false, category: HARNESS_FAILURE.timeout };
  if (result.sessionMismatch) return { ok: false, category: HARNESS_FAILURE.sessionMismatch };

  const message = `${result.errorMessage ?? ''}`;
  if (SESSION_BUSY_PATTERN.test(message)) return { ok: false, category: HARNESS_FAILURE.sessionBusy };
  if (SESSION_REFUSED_PATTERN.test(message)) return { ok: false, category: HARNESS_FAILURE.sessionRefused };

  if (result.exitCode !== 0) return { ok: false, category: HARNESS_FAILURE.harnessError };
  if (result.turnEndReason !== 'completed') return { ok: false, category: HARNESS_FAILURE.roundFailed };
  return { ok: true, category: null };
}

function buildHandle(child, sessionPromise, earlyPromise, exitPromise, record) {
  return {
    child,
    get pid() {
      return child?.pid ?? null;
    },
    get record() {
      return record;
    },
    sessionId: sessionPromise,
    earlySignal: earlyPromise,
    exited: exitPromise,
  };
}

function safeClose(fd) {
  try {
    fs.closeSync(fd);
  } catch {
    /* 已关闭 */
  }
}

function describeError(error) {
  if (error === null || error === undefined) return null;
  return { code: error.code ?? null, message: error.message ?? String(error) };
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{timeoutMs?: number}} options
 */
function defaultExec(bin, args, options = {}) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout: options.timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          killed: Boolean(error?.killed),
          timedOut: Boolean(error?.killed && options.timeoutMs),
          // ps 对不存在 PID 的正常表现由调用环境决定；仅显式可识别时标记，其他失败保持 unknown。
          notFound: Boolean(error && !error.killed && /no such process|not found/i.test(String(stderr ?? error.message ?? ''))),
        });
      });
    } catch (error) {
      // 例如沙箱拒绝执行 ps：返回不可判定，由调用方按 unknown 保守处理。
      resolve({ code: 1, stdout: '', stderr: error.message ?? String(error) });
    }
  });
}
