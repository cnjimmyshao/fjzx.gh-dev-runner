import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { WorkdirError, branchFor, createWorkdirManager, taskDirFor } from '../src/workdir.js';
import { cleanup, tempDir } from './helpers.js';

/**
 * 本机可能同时装着多个 git；优先环境变量，其次 PATH，最后常见的 Homebrew 位置。
 * 都不可用时跳过真实 git 边界测试，并打印原因。
 */
function resolveGitBin() {
  const candidates = [process.env.FJZX_TEST_GIT_BIN, 'git', '/opt/homebrew/bin/git', '/usr/bin/git'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

const gitBin = resolveGitBin();

function git(args, cwd) {
  return execFileSync(gitBin, args, { cwd, encoding: 'utf8' });
}

function createSourceRepo() {
  const dir = tempDir('fjzx-src-');
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

test('每个 Issue 得到独立 worktree 与分支，重复 START 复用同一目录', { skip: gitBin === null && '本机没有可用的 git' }, async () => {
  const root = tempDir('fjzx-wt-');
  const sourceDir = createSourceRepo();
  try {
    const repository = {
      repo: 'owner/repo',
      allowedActors: ['alice'],
      sourceDir,
      baseBranch: 'main',
      worktreeDir: root,
      maxConcurrentHarnesses: 1,
    };
    const manager = createWorkdirManager({ gitBin });
    const first = await manager.prepare({ repository, issueNumber: 3, kind: 'start', binding: null });
    assert.equal(first.dir, path.join(root, 'issue-3'));
    assert.equal(first.branch, 'fjzx/issue-3');
    assert.equal(first.worktreeCreated, true);
    assert.equal(fs.existsSync(path.join(first.dir, '.git')), true);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], first.dir).trim(), 'fjzx/issue-3');

    const other = await manager.prepare({ repository, issueNumber: 4, kind: 'start', binding: null });
    assert.notEqual(other.dir, first.dir);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], other.dir).trim(), 'fjzx/issue-4');

    const again = await manager.prepare({
      repository,
      issueNumber: 3,
      kind: 'start',
      binding: { dir: first.dir, source: sourceDir, branch: 'fjzx/issue-3', worktreeCreated: true },
    });
    assert.equal(again.dir, first.dir);
  } finally {
    cleanup(root);
    cleanup(sourceDir);
  }
});

test('RESUME 必须回到原目录：目录不存在时明确失败', { skip: gitBin === null && '本机没有可用的 git' }, async () => {
  const root = tempDir('fjzx-wt-');
  const sourceDir = createSourceRepo();
  try {
    const repository = {
      repo: 'owner/repo',
      allowedActors: ['alice'],
      sourceDir,
      baseBranch: 'main',
      worktreeDir: root,
      maxConcurrentHarnesses: 1,
    };
    const manager = createWorkdirManager({ gitBin });
    await assert.rejects(
      manager.prepare({
        repository,
        issueNumber: 3,
        kind: 'resume',
        binding: { dir: path.join(root, 'issue-3'), source: sourceDir, branch: 'fjzx/issue-3' },
      }),
      (error) => error instanceof WorkdirError && error.category === 'task_dir_missing',
    );
  } finally {
    cleanup(root);
    cleanup(sourceDir);
  }
});

test('绑定与当前配置不一致时停止并报告，不静默换目录', { skip: gitBin === null && '本机没有可用的 git' }, async () => {
  const root = tempDir('fjzx-wt-');
  const sourceDir = createSourceRepo();
  try {
    const repository = {
      repo: 'owner/repo',
      allowedActors: ['alice'],
      sourceDir,
      baseBranch: 'main',
      worktreeDir: root,
      maxConcurrentHarnesses: 1,
    };
    const manager = createWorkdirManager({ gitBin });
    await assert.rejects(
      manager.prepare({
        repository,
        issueNumber: 3,
        kind: 'resume',
        binding: { dir: path.join(root, 'issue-3'), source: '/elsewhere', branch: 'fjzx/issue-3' },
      }),
      (error) => error instanceof WorkdirError && error.category === 'binding_config_mismatch',
    );
  } finally {
    cleanup(root);
    cleanup(sourceDir);
  }
});

test('源仓库目录缺失时拒绝代建', { skip: gitBin === null && '本机没有可用的 git' }, async () => {
  const root = tempDir('fjzx-wt-');
  try {
    const repository = {
      repo: 'owner/repo',
      allowedActors: ['alice'],
      sourceDir: path.join(root, 'missing-source'),
      baseBranch: 'main',
      worktreeDir: root,
      maxConcurrentHarnesses: 1,
    };
    const manager = createWorkdirManager({ gitBin });
    await assert.rejects(
      manager.prepare({ repository, issueNumber: 3, kind: 'start', binding: null }),
      (error) => error instanceof WorkdirError && error.category === 'source_dir_missing',
    );
    assert.equal(fs.existsSync(path.join(root, 'missing-source')), false);
  } finally {
    cleanup(root);
  }
});

test('起点分支不存在时明确失败', { skip: gitBin === null && '本机没有可用的 git' }, async () => {
  const root = tempDir('fjzx-wt-');
  const sourceDir = createSourceRepo();
  try {
    const repository = {
      repo: 'owner/repo',
      allowedActors: ['alice'],
      sourceDir,
      baseBranch: 'no-such-branch',
      worktreeDir: root,
      maxConcurrentHarnesses: 1,
    };
    const manager = createWorkdirManager({ gitBin });
    await assert.rejects(
      manager.prepare({ repository, issueNumber: 3, kind: 'start', binding: null }),
      (error) => error instanceof WorkdirError && error.category === 'base_branch_missing',
    );
  } finally {
    cleanup(root);
    cleanup(sourceDir);
  }
});

test('目录与分支的派生是稳定且按 Issue 唯一的', () => {
  assert.equal(branchFor(12), 'fjzx/issue-12');
  assert.equal(taskDirFor({ worktreeDir: '/w' }, 12), '/w/issue-12');
});
