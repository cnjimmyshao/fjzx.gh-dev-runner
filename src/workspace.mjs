// 任务工作目录准备：每个「仓库 + Issue」使用独立目录，不切换、不覆盖部署者正在用的目录。
//
// 两种来源：
//   sourceDir 给了就按 git worktree 从该仓库拉一个独立工作树（不与部署者的检出互相影响）。
//   repoDir 给了就直接用这个已备好的任务根目录（本工具不代替维护者做首次 clone）。
// 已保存绑定时只核对目录仍在，不重新准备，避免覆盖任务未提交的工作。

import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function worktreePath(repository, issueNumber) {
  return join(repository.worktreeDir, `issue-${issueNumber}`);
}

export function worktreeArgs({ repository, issueNumber, path }) {
  const args = ['-C', repository.sourceDir, 'worktree', 'add', '-b', `fjzx/issue-${issueNumber}`, path];
  if (repository.baseBranch !== undefined) args.push(repository.baseBranch);
  return args;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * git 调用的输出捕获与其它子进程一致：把结果落到给定文件，调用结束后读回；只要退出码与
 * stderr 摘要，因此文件用完即不再需要。
 *
 * 缺省 `capture` 用 `file` 时**必须**同时给出 `files`，否则真实 exec 会拒绝执行；
 * 与其在运行期才发现，不如在这里按用法错误报出来。
 */
async function gitSucceeded(exec, args, { capture = 'file', files } = {}) {
  if (capture === 'file' && files === undefined) {
    return { ok: false, message: 'git 调用缺少输出文件路径（capture=file 需要 files）' };
  }
  try {
    const result = await exec({
      command: 'git',
      args,
      timeoutMs: 120000,
      capture,
      ...(files ?? {}),
    });
    if (result.exitCode === 0) return { ok: true };
    const message = (result.stderr ?? '').trim().split(/\r?\n/)[0] ?? '';
    return { ok: false, message };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

/**
 * @param {object} options
 * @param {'file'|'pipe'} [options.capture] 传给 exec 的输出捕获方式
 * @param {{stdoutFile: string, stderrFile: string}} [options.files] capture=file 时必填
 * @returns {Promise<{ok: true, dir: string, branch: string|null, source: string|null, worktreeCreated: boolean}
 *   | {ok: false, reason: string}>}
 */
export async function prepareWorkspace({ repository, issueNumber, exec, existing, capture = 'file', files }) {
  if (existing !== null && existing !== undefined) {
    if (!isDirectory(existing.dir)) {
      return {
        ok: false,
        reason: `绑定的工作目录已不存在：${existing.dir}。不静默换目录或新建会话，请人工核对该目录后再发指令。`,
      };
    }
    return {
      ok: true,
      dir: existing.dir,
      branch: existing.branch ?? null,
      source: existing.source ?? null,
      worktreeCreated: false,
    };
  }

  if (repository.sourceDir !== undefined) {
    const path = worktreePath(repository, issueNumber);
    // worktree 在 sourceDir 之外时 git 需要目标父目录已存在；已存在则交给 git 自己判定。
    if (!isDirectory(path)) {
      mkdirSync(dirname(path), { recursive: true });
      const created = await gitSucceeded(exec, worktreeArgs({ repository, issueNumber, path }), { capture, files });
      if (!created.ok) {
        rmSync(path, { recursive: true, force: true });
        return {
          ok: false,
          reason: `创建 git worktree 失败（${repository.sourceDir} → ${path}）：${created.message || 'git 未给出信息'}`,
        };
      }
    }
    return {
      ok: true,
      dir: path,
      branch: `fjzx/issue-${issueNumber}`,
      source: repository.sourceDir,
      worktreeCreated: true,
    };
  }

  // repoDir 的 Contract 是「部署者已经备好的任务根目录」：不存在说明路径写错或还没准备，
  // 此时静默建一个空目录会让 Harness 在没有目标仓库的情况下开工，因此明确报错。
  const dir = repository.repoDir;
  if (!isDirectory(dir)) {
    return {
      ok: false,
      reason: `repoDir 不存在或不是目录：${dir}。请先在该机器上准备好任务仓库；本工具不代替维护者做首次 clone。`,
    };
  }
  return { ok: true, dir, branch: null, source: null, worktreeCreated: false };
}
