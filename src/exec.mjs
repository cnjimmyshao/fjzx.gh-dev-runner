// 子进程调用：统一超时、输出捕获与结果结构。
//
// 两种输出捕获方式：
//   `capture: 'file'`（缺省）把子进程的 stdout/stderr 直接接到给定文件，调用结束后读回。
//   真实 CLI 输出因此天然落地到日志目录，也不依赖命名管道；不允许管道捕获子进程输出的
//   受限环境同样可用。
//   `capture: 'pipe'` 走 stdout/stderr 管道，适合要在终端实时看子进程输出的场合。

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CAPTURE_MODES = ['file', 'pipe'];

/** 子进程无法启动或超时：调用方按调用失败回报，不当作模型结果或成功。 */
export class ExecError extends Error {
  constructor(message, { code, exitCode, stderr, timedOut } = {}) {
    super(message);
    this.name = 'ExecError';
    this.code = code ?? null;
    this.exitCode = exitCode ?? null;
    this.stderr = stderr ?? '';
    this.timedOut = timedOut === true;
  }
}

function readIfPresent(path) {
  if (path === undefined) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} options.args
 * @param {string} [options.cwd]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.timeoutMs] 0 或省略表示不限时
 * @param {'file'|'pipe'} [options.capture]
 * @param {string} [options.stdoutFile] capture=file 时的 stdout 落盘路径
 * @param {string} [options.stderrFile] capture=file 时的 stderr 落盘路径
 */
export function execFileAsync(options) {
  const {
    command, args, cwd, env, timeoutMs = 0, capture = 'file', stdoutFile, stderrFile,
  } = options;
  const useFiles = capture === 'file';
  if (useFiles && (stdoutFile === undefined || stderrFile === undefined)) {
    return Promise.reject(new ExecError('capture=file 需要同时给出 stdoutFile 与 stderrFile'));
  }
  let stdoutFd;
  let stderrFd;
  if (useFiles) {
    try {
      mkdirSync(dirname(stdoutFile), { recursive: true });
      mkdirSync(dirname(stderrFile), { recursive: true });
      stdoutFd = openSync(stdoutFile, 'w');
      stderrFd = openSync(stderrFile, 'w');
    } catch (error) {
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      return Promise.reject(new ExecError(`无法创建子进程输出文件：${error.message}`));
    }
  }

  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        // file 模式把子进程的 stdout/stderr 直接接到文件，父进程不占管道。
        stdio: useFiles ? ['ignore', stdoutFd, stderrFd] : ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new ExecError(`${command} 无法启动：${error.message}`, { code: error.code }));
      return;
    } finally {
      // 描述符已交给子进程：父进程必须关掉自己的副本，否则句柄泄漏且文件可能读不完整。
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs)
      : undefined;
    if (timer !== undefined) timer.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn(value);
    };

    child.on('error', (error) => {
      finish(reject, new ExecError(`${command} 无法启动：${error.message}`, { code: error.code, stderr }));
    });
    child.on('close', (code) => {
      if (timedOut) {
        finish(reject, new ExecError(`${command} 超时（${timeoutMs}ms）`, {
          code: 'ETIMEDOUT', exitCode: code, stderr, timedOut: true,
        }));
        return;
      }
      finish(resolvePromise, {
        exitCode: code ?? 1,
        stdout: useFiles ? readIfPresent(stdoutFile) : stdout,
        stderr: useFiles ? readIfPresent(stderrFile) : stderr,
        stdoutFile: useFiles ? stdoutFile : undefined,
        stderrFile: useFiles ? stderrFile : undefined,
      });
    });
  });
}
