/**
 * 任务工作目录准备：每个 repository + Issue 一个独立 worktree，绝不让两个 Issue 共享可写检出。
 *
 * 目录与分支由配置稳定派生；绑定与当前配置不一致时明确失败并报告，
 * 不静默换目录、也不代建缺失的源仓库目录。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class WorkdirError extends Error {
  /**
   * @param {string} message
   * @param {string} category 稳定的本机诊断分类（不进入 GitHub 公开反馈）
   */
  constructor(message, category) {
    super(message);
    this.name = 'WorkdirError';
    this.category = category ?? 'workdir_failed';
  }
}

/**
 * 分支命名：一个任务一个分支，续接时不新建重复分支。
 * @param {number} issueNumber
 */
export function branchFor(issueNumber) {
  return `fjzx/issue-${issueNumber}`;
}

/**
 * 每个 Issue 唯一的工作目录。
 * @param {{worktreeDir: string}} repository
 * @param {number} issueNumber
 */
export function taskDirFor(repository, issueNumber) {
  return path.join(repository.worktreeDir, `issue-${issueNumber}`);
}

/**
 * @param {{gitBin?: string, exec?: Function}} [options]
 */
export function createWorkdirManager(options = {}) {
  const gitBin = options.gitBin ?? 'git';
  const exec = options.exec ?? defaultGitExec;

  /**
   * @param {string[]} args
   * @param {string} [cwd]
   */
  async function git(args, cwd) {
    return exec(gitBin, args, { cwd, timeoutMs: 120_000 });
  }

  return {
    branchFor,
    taskDirFor: (repository, issueNumber) => taskDirFor(repository, issueNumber),

    /**
     * 校验并（首次 START 时）创建任务工作目录。
     * @param {object} input
     * @param {object} input.repository 配置中的仓库项
     * @param {number} input.issueNumber
     * @param {'start'|'resume'} input.kind
     * @param {object|null} input.binding 已有绑定
     * @returns {Promise<{dir: string, branch: string, source: string, worktreeCreated: boolean}>}
     */
    async prepare(input) {
      const { repository, issueNumber, kind, binding } = input;
      const dir = taskDirFor(repository, issueNumber);
      const branch = branchFor(issueNumber);
      const source = repository.sourceDir;

      if (binding !== null && binding !== undefined) {
        if (binding.dir !== dir || binding.source !== source || binding.branch !== branch) {
          throw new WorkdirError(
            `任务绑定与当前配置不一致（binding.dir/source/branch 与派生结果不同），需要维护者核对后恢复`,
            'binding_config_mismatch',
          );
        }
      }

      if (kind === 'resume') {
        if (!isDirectory(dir)) {
          throw new WorkdirError('任务工作目录不存在，续接必须回到原目录，需要人工恢复', 'task_dir_missing');
        }
        if (!fs.existsSync(path.join(dir, '.git'))) {
          throw new WorkdirError('任务工作目录已存在但不是 git worktree，需要人工核对', 'task_dir_not_worktree');
        }
        await assertWorktreeOfSource(git, source, dir);
        return {
          dir,
          branch,
          source,
          worktreeCreated: Boolean(binding?.worktreeCreated),
          currentBranch: await currentBranch(git, dir),
        };
      }

      if (isDirectory(dir)) {
        if (!fs.existsSync(path.join(dir, '.git'))) {
          throw new WorkdirError('任务工作目录已存在但不是 git worktree，需要人工核对', 'task_dir_not_worktree');
        }
        await assertWorktreeOfSource(git, source, dir);
        return {
          dir,
          branch,
          source,
          worktreeCreated: Boolean(binding?.worktreeCreated),
          currentBranch: await currentBranch(git, dir),
        };
      }

      if (!isDirectory(source)) {
        throw new WorkdirError('配置的源仓库目录不存在，拒绝代建', 'source_dir_missing');
      }

      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const exists = await git(['-C', source, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (exists.code === 0) {
        await gitOrThrow(['-C', source, 'worktree', 'add', dir, branch], 'worktree_add_failed');
      } else {
        const start = await resolveStartPoint(git, source, repository.baseBranch);
        await gitOrThrow(['-C', source, 'worktree', 'add', '-b', branch, dir, start], 'worktree_add_failed');
      }
      return { dir, branch, source, worktreeCreated: true, currentBranch: branch };
    },
  };

  /**
   * @param {string[]} args
   * @param {string} category
   */
  async function gitOrThrow(args, category) {
    const result = await git(args);
    if (result.code !== 0) {
      throw new WorkdirError(`git ${args.join(' ')} 失败: ${firstLine(result.stderr)}`, category);
    }
    return result;
  }
}

/**
 * 续接 / 复用前确认该目录确实还是配置源仓库的 worktree：
 * 目录被替换、worktree 被移除或指向别的源仓库时明确停止，而不是在错误 checkout 里继续。
 * @param {Function} git
 * @param {string} source
 * @param {string} dir
 */
async function assertWorktreeOfSource(git, source, dir) {
  const listed = await git(['-C', source, 'worktree', 'list', '--porcelain']);
  if (listed.code !== 0) {
    throw new WorkdirError(`无法读取源仓库 worktree 列表: ${firstLine(listed.stderr)}`, 'worktree_list_failed');
  }
  const expected = canonicalPath(dir);
  const registered = listed.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => canonicalPath(line.slice('worktree '.length).trim()));
  if (!registered.includes(expected)) {
    throw new WorkdirError('任务工作目录不是配置源仓库的 worktree，需要人工核对', 'worktree_source_mismatch');
  }
}

/**
 * 当前检出分支；取不到时返回 null（只用于本机提示，不作为失败条件）。
 * @param {Function} git
 * @param {string} dir
 */
async function currentBranch(git, dir) {
  const result = await git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value === '' ? null : value;
}

/**
 * 起点分支优先用本地分支；本地不存在时退回 origin/<baseBranch>。
 * @param {Function} git
 * @param {string} source
 * @param {string} baseBranch
 */
async function resolveStartPoint(git, source, baseBranch) {
  const local = await git(['-C', source, 'rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`]);
  if (local.code === 0) return baseBranch;
  const remote = await git(['-C', source, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`]);
  if (remote.code === 0) return `origin/${baseBranch}`;
  throw new WorkdirError(`起点分支不存在: ${baseBranch}`, 'base_branch_missing');
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number}} options
 */
function defaultGitExec(bin, args, options = {}) {
  return new Promise((resolve) => {
    const done = (error, stdout, stderr) =>
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: error ?? null,
      });
    try {
      execFile(
        bin,
        args,
        { cwd: options.cwd, timeout: options.timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
        done,
      );
    } catch (error) {
      done(error, '', error.message ?? String(error));
    }
  });
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').find((entry) => entry.trim() !== '');
  return line === undefined ? '' : line.trim();
}

/** git 报告的是解析过符号链接的真实路径（macOS 上 /var 与 /private/var），比较前先归一。 */
function canonicalPath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
