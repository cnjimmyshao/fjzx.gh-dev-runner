/**
 * 本机运行追踪与终端日志。
 *
 * - audit：`<stateDir>/audit/audit.jsonl`，append-only，用于事后回答“哪条命令在什么时候
 *   由哪台 Runner 拉起了哪个 session、运行多久、如何结束”（docs/current/03-runner-trigger.md）。
 * - 终端日志只写本机；公开到 GitHub 的文字由 runner 用固定枚举拼装，不经过这里。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 本机诊断文本的最大保留长度，避免把整段模型输出写进审计记录。 */
const DIAGNOSTIC_LIMIT = 500;

/**
 * 按保留上限清理 `<stateDir>/runs/` 下的历史运行目录。
 * 仍占槽的运行（starting / running / unknown）必须排除在外：子进程还在写自己的事件流。
 * @param {string} stateDir
 * @param {number} keep 至少保留最近几次运行
 * @param {{protect?: Iterable<string>}} [options] 需要保护的 runDir 绝对路径
 * @returns {{removed: string[]}}
 */
export function pruneRunDirs(stateDir, keep, options = {}) {
  const runsDir = path.join(stateDir, 'runs');
  const protectedDirs = new Set(options.protect ?? []);
  if (!fs.existsSync(runsDir)) return { removed: [] };

  const entries = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(runsDir, entry.name);
    if (protectedDirs.has(full)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    entries.push({ full, mtime });
  }
  entries.sort((left, right) => right.mtime - left.mtime);

  const removed = [];
  for (const entry of entries.slice(Math.max(0, keep))) {
    try {
      fs.rmSync(entry.full, { recursive: true, force: true });
      removed.push(entry.full);
    } catch {
      /* 清理失败不影响本轮执行 */
    }
  }
  return { removed };
}

/**
 * @param {string} stateDir
 */
export function createAuditLog(stateDir) {
  const dir = path.join(stateDir, 'audit');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'audit.jsonl');

  return {
    file,
    /**
     * 追加一条审计记录；写入失败不影响本轮执行，只打印到终端。
     * @param {object} record
     */
    append(record) {
      const line = JSON.stringify({ at: new Date().toISOString(), ...record });
      try {
        fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
      } catch (error) {
        process.stderr.write(`audit 写入失败: ${error.code ?? error.message}\n`);
      }
    },
  };
}

/**
 * 截断本机诊断文本（保留给本地审计，不进入 GitHub 反馈）。
 * @param {unknown} value
 */
export function truncateDiagnostic(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return text.length > DIAGNOSTIC_LIMIT ? `${text.slice(0, DIAGNOSTIC_LIMIT)}…` : text;
}

/**
 * 带时间戳的终端日志。
 * @param {string} scope
 */
export function createLogger(scope, stream = process.stdout) {
  const write = (level, message) => {
    stream.write(`${new Date().toISOString()} [${level}] ${scope}: ${message}\n`);
  };
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  };
}
