import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  bindingProblems, createBinding, emptyState, findCommand, issueState, loadState, recordCommand, saveState, statePath,
} from '../src/state.mjs';
import { prepareWorkspace, worktreeArgs, worktreePath } from '../src/workspace.mjs';
import { cleanup, makeTempDir } from './helpers.mjs';

test('状态按仓库身份 + Issue 编号寻址，不同仓库同号不混淆', () => {
  const state = emptyState();
  const first = issueState(state, 'owner/one', 7);
  const second = issueState(state, 'owner/two', 7);
  assert.notEqual(first, second);
  first.seenSeq = 42;
  assert.equal(second.seenSeq, 0);
  assert.equal(state.repositories['owner/one']['7'], first);
  assert.equal(state.repositories['owner/one'][7], first, 'Issue 编号按字符串存放');
});

test('保存与加载往返一致，缺文件视为首次接入', () => {
  const root = makeTempDir();
  try {
    const path = statePath(root);
    assert.deepEqual(loadState(path), emptyState());
    const state = emptyState();
    issueState(state, 'owner/project', 9).seenSeq = 123;
    saveState(path, state);
    assert.equal(loadState(path).repositories['owner/project']['9'].seenSeq, 123);
  } finally {
    cleanup(root);
  }
});

test('状态文件损坏或版本不符时明确失败', () => {
  const root = makeTempDir();
  try {
    const path = statePath(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(path, 'not json', 'utf8');
    assert.throws(() => loadState(path), /不是合法 JSON/);
    writeFileSync(path, JSON.stringify({ version: 99 }), 'utf8');
    assert.throws(() => loadState(path), /版本不匹配/);
  } finally {
    cleanup(root);
  }
});

test('同一评论 id 只保留一条命令记录', () => {
  const state = emptyState();
  const entry = issueState(state, 'owner/project', 1);
  recordCommand(entry, { id: 5, author: 'a', status: 'claimed', at: 't0' });
  recordCommand(entry, { id: 5, author: 'a', status: 'completed' });
  assert.equal(entry.commands.length, 1);
  assert.equal(entry.commands[0].status, 'completed');
  assert.equal(entry.commands[0].at, 't0');
  assert.equal(findCommand(entry, 5).status, 'completed');
  assert.equal(findCommand(entry, 6), null);
});

test('绑定核对来源与执行机，不一致时报告', () => {
  const repository = { repo: 'owner/project', sourceDir: 'C:/src/project' };
  const binding = createBinding({ runnerId: 'mb01', dir: 'C:/ws/1', sessionId: 's1', branch: 'b', source: 'C:/src/project', worktreeCreated: true });
  assert.deepEqual(bindingProblems(binding, repository, 'mb01'), []);
  assert.match(bindingProblems(binding, repository, 'mb02')[0], /本机是 mb02/);
  assert.match(bindingProblems({ ...binding, source: 'C:/src/other' }, repository, 'mb01')[0], /sourceDir/);
  assert.deepEqual(bindingProblems(null, repository, 'mb01'), ['没有已保存的绑定']);
});

test('已保存绑定时只核对目录仍存在，不重新准备目录', async () => {
  const root = makeTempDir();
  try {
    const dir = join(root, 'work');
    mkdirSync(dir, { recursive: true });
    const exec = async () => {
      throw new Error('不应调用 git');
    };
    const existing = { dir, branch: 'fjzx/issue-1', source: 'C:/src' };
    const plan = await prepareWorkspace({ repository: { repo: 'o/p', sourceDir: 'C:/src' }, issueNumber: 1, exec, existing });
    assert.deepEqual(plan, { ok: true, dir, branch: 'fjzx/issue-1', source: 'C:/src', worktreeCreated: false });

    const missing = await prepareWorkspace({
      repository: { repo: 'o/p', sourceDir: 'C:/src' },
      issueNumber: 1,
      exec,
      existing: { dir: join(root, 'gone') },
    });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /工作目录已不存在/);
  } finally {
    cleanup(root);
  }
});

test('首次任务按 sourceDir 建独立 worktree，失败时不留半成品目录', async () => {
  const root = makeTempDir();
  try {
    const repository = { repo: 'owner/project', sourceDir: join(root, 'src'), worktreeDir: join(root, 'ws') };
    const calls = [];
    const okExec = async (options) => {
      calls.push(options);
      mkdirSync(worktreePath(repository, 9), { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const plan = await prepareWorkspace({ repository, issueNumber: 9, exec: okExec, existing: null });
    assert.equal(plan.ok, true);
    assert.equal(plan.dir, worktreePath(repository, 9));
    assert.equal(plan.branch, 'fjzx/issue-9');
    assert.equal(plan.source, repository.sourceDir);
    assert.equal(plan.worktreeCreated, true);
    assert.equal(calls[0].command, 'git');
    assert.deepEqual(calls[0].args, worktreeArgs({ repository, issueNumber: 9, path: worktreePath(repository, 9) }));
    assert.ok(calls[0].args.includes('-b') && calls[0].args.includes('fjzx/issue-9'));
    assert.equal(calls[0].args.at(-1), worktreePath(repository, 9), 'baseBranch 缺省时从 sourceDir 当前 HEAD 起');

    const failExec = async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' });
    const failed = await prepareWorkspace({ repository, issueNumber: 10, exec: failExec, existing: null });
    assert.equal(failed.ok, false);
    assert.match(failed.reason, /创建 git worktree 失败/);
    assert.equal(existsSync(worktreePath(repository, 10)), false, '失败时清理空目录，交给人工核对');
  } finally {
    cleanup(root);
  }
});

test('给了 baseBranch 时 worktree 从该分支起', () => {
  const repository = { repo: 'owner/project', sourceDir: 'C:/src', worktreeDir: 'C:/ws', baseBranch: 'main' };
  assert.deepEqual(worktreeArgs({ repository, issueNumber: 3, path: 'C:/ws/issue-3' }), [
    '-C', 'C:/src', 'worktree', 'add', '-b', 'fjzx/issue-3', 'C:/ws/issue-3', 'main',
  ]);
});

test('只用 repoDir 的任务根目录会被准备好，不做 git 操作', async () => {
  const root = makeTempDir();
  try {
    const repoDir = join(root, 'ready', 'project');
    const exec = async () => {
      throw new Error('不应调用 git');
    };
    const plan = await prepareWorkspace({ repository: { repo: 'o/p', repoDir }, issueNumber: 1, exec, existing: null });
    assert.equal(plan.ok, true);
    assert.equal(plan.dir, repoDir);
    assert.equal(existsSync(repoDir), true);
    assert.equal(plan.worktreeCreated, false);
  } finally {
    cleanup(root);
  }
});
