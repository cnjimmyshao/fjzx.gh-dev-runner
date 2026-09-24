// 子进程调用：统一超时、输出捕获与结果结构。
//
// 两种输出捕获方式：
//   `capture: 'file'`（缺省）把子进程的 stdout/stderr 直接接到给定文件，调用结束后读回。
//   真实 CLI 输出因此天然落地到日志目录，也不依赖命名管道；不允许管道捕获子进程输出的
//   受限环境同样可用。
//   `capture: 'pipe'` 走 stdout/stderr 管道，适合要在终端实时看子进程输出的场合。

import { spawn, execFileSync } from 'node:child_process';
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
 * 强制终止一棵进程树（尽力而为）。
 *
 * Harness 自己会再起子进程（工具调用、shell 等）；只杀直接子进程会留下仍在写文件的孤儿。
 * Windows 用 `taskkill /T /F`；其他平台对进程组发 SIGKILL（spawn 时 detach 才能按组杀，
 * 这里退化为杀直接子进程，行为与之前一致）。
 */
function killTree(pid) {
  if (!Number.isInteger(pid)) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // 进程可能已经退出：忽略即可，超时结果照常回报。
  }
}

/**
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} options.args
 * @param {string} [options.cwd]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.stdin] 可选；提供时把文本写入子进程 stdin，避免把任务正文放进命令行参数
 * @param {number} [options.timeoutMs] 0 或省略表示不限时
 * @param {'file'|'pipe'} [options.capture]
 * @param {string} [options.stdoutFile] capture=file 时的 stdout 落盘路径
 * @param {string} [options.stderrFile] capture=file 时的 stderr 落盘路径
 */
export function execFileAsync(options) {
  const {
    command, args, cwd, env, stdin, timeoutMs = 0, capture = 'file', stdoutFile, stderrFile,
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
        // 任务正文可走 stdin；file 模式仍把 stdout/stderr 直接接到文件，父进程不占输出管道。
        stdio: useFiles
          ? [stdin === undefined ? 'ignore' : 'pipe', stdoutFd, stderrFd]
          : [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
    let stdinError = null;
    let timedOut = false;
    let settled = false;
    let graceTimer;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        // 硬超时不能只发一次可被忽略的终止信号：先请它退出，宽限期内没退就强制终止整棵进程树。
        child.kill();
        graceTimer = setTimeout(() => killTree(child.pid), 5000);
        graceTimer.unref?.();
      }, timeoutMs)
      : undefined;
    if (timer !== undefined) timer.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    if (child.stdin !== null) {
      // 子进程若在读完前失败，stdin 可能报 EPIPE；真实失败仍由进程退出码／stderr 判读。
      child.stdin.on('error', (error) => { stdinError = error; });
      child.stdin.end(stdin);
    }
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
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
      if ((code ?? 1) === 0 && stdinError !== null) {
        finish(reject, new ExecError(`${command} 写入 stdin 失败：${stdinError.message}`, {
          code: stdinError.code,
          exitCode: code,
          stderr: useFiles ? readIfPresent(stderrFile) : stderr,
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
