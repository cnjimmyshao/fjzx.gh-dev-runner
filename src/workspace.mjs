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

async function gitSucceeded(exec, args) {
  try {
    const result = await exec({ command: 'git', args, timeoutMs: 120000 });
    return result.exitCode === 0 ? { ok: true } : { ok: false, message: (result.stderr ?? '').trim().split(/\r?\n/)[0] ?? '' };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

/**
 * @returns {Promise<{ok: true, dir: string, branch: string, source: string|null, worktreeCreated: boolean}
 *   | {ok: false, reason: string}>}
 */
export async function prepareWorkspace({ repository, issueNumber, exec, existing, tempPath }) {
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
      const created = await gitSucceeded(exec, worktreeArgs({ repository, issueNumber, path }));
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

  const dir = repository.repoDir;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `无法准备任务目录 ${dir}：${error.message}` };
  }
  return { ok: true, dir, branch: null, source: null, worktreeCreated: false };
}
