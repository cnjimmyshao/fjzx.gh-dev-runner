import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { execFileAsync } from '../src/exec.mjs';
import { prepareWorkspace } from '../src/workspace.mjs';
import { cleanup, makeTempDir } from './helpers.mjs';

/**
 * 真实 git 的 worktree 准备：用生产缺省调用形态（`execFileAsync` + `capture=file`）跑一次
 * 真实 `git worktree add`，核对 sourceDir 路径确实能建出独立工作树。
 *
 * 本机没有 git 或环境不允许写 `.git` 时跳过（跳过 ≠ 通过）。
 */
function gitAvailable(root) {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('真实 git：按 sourceDir 建出独立 worktree 并切到任务分支', async (t) => {
  const root = makeTempDir('fjzx-issue9-git-');
  t.after(() => cleanup(root));
  const src = join(root, 'src');
  const ws = join(root, 'ws');
  if (!gitAvailable(src)) {
    t.skip('本机 git 不可用或不允许写 .git');
    return;
  }
  execFileSync('git', ['-C', src, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'ignore' });

  const logs = join(root, 'logs');
  const plan = await prepareWorkspace({
    repository: { repo: 'owner/project', sourceDir: src, worktreeDir: ws },
    issueNumber: 1,
    exec: execFileAsync,
    existing: null,
    capture: 'file',
    files: { stdoutFile: join(logs, 'git.stdout.log'), stderrFile: join(logs, 'git.stderr.log') },
  });

  assert.equal(plan.ok, true, plan.ok ? '' : plan.reason);
  assert.equal(plan.dir, join(ws, 'issue-1'));
  assert.equal(plan.worktreeCreated, true);
  assert.equal(plan.source, src);
  assert.equal(existsSync(join(plan.dir, '.git')), true, 'worktree 落盘');
  const branch = execFileSync('git', ['-C', plan.dir, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
  assert.equal(branch, 'fjzx/issue-1');
  assert.equal(existsSync(join(logs, 'git.stdout.log')), true, 'git 调用也留下本机日志');
});

test('真实 git：worktree 失败时给出可读原因，不留半成品目录', async (t) => {
  const root = makeTempDir('fjzx-issue9-git-');
  t.after(() => cleanup(root));
  const src = join(root, 'not-a-repo');
  if (!gitAvailable(src)) {
    t.skip('本机 git 不可用或不允许写 .git');
    return;
  }
  // 删掉 .git：sourceDir 指向的不是仓库，worktree add 必然失败。
  rmSync(join(src, '.git'), { recursive: true, force: true });
  const plan = await prepareWorkspace({
    repository: { repo: 'owner/project', sourceDir: src, worktreeDir: join(root, 'ws') },
    issueNumber: 2,
    exec: execFileAsync,
    existing: null,
    capture: 'file',
    files: { stdoutFile: join(root, 'git.stdout.log'), stderrFile: join(root, 'git.stderr.log') },
  });

  assert.equal(plan.ok, false);
  assert.match(plan.reason, /创建 git worktree 失败/);
  assert.ok(plan.reason.length > '创建 git worktree 失败（）'.length, '带上 git 的实际错误信息');
  assert.match(plan.reason, /not a git repository|不是.*仓库/i);
  assert.equal(existsSync(join(root, 'ws', 'issue-2')), false, '失败后清理空目录');
});
