import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ConfigError } from '../src/config.js';
import { main, parseArgs } from '../src/index.js';
import { StateStore } from '../src/state.js';
import {
  cleanup,
  createFakeAudit,
  createFakeGithub,
  createFakeHarness,
  createFakeWorkdir,
  makeConfig,
  tempDir,
} from './helpers.js';

function writeEnv(root, overrides = {}) {
  const stateDir = path.join(root, 'state');
  const sourceDir = path.join(root, 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const envFile = path.join(root, '.env');
  fs.writeFileSync(
    envFile,
    [
      'RUNNER_NAME=MB01',
      `STATE_DIR=${stateDir}`,
      'DSH_BIN=/bin/echo',
      `GIT_BIN=${process.env.FJZX_TEST_GIT_BIN ?? 'git'}`,
      `REPOSITORIES_JSON=${JSON.stringify([
        {
          repo: 'owner/repo',
          allowedActors: ['alice'],
          sourceDir,
          worktreeDir: path.join(root, 'wt'),
        },
      ])}`,
      ...(overrides.extraLines ?? []),
    ].join('\n'),
  );
  return { envFile, stateDir, sourceDir };
}

function silentStdout() {
  const chunks = [];
  return { write: (chunk) => chunks.push(chunk), text: () => chunks.join('') };
}

test('parseArgs 解析命令与选项，并在缺值时明确报错', () => {
  assert.deepEqual(parseArgs([]), { command: 'run', envFile: null, once: false, wait: false, flags: {} });
  assert.deepEqual(parseArgs(['--env', '/tmp/x', '--once', '--wait']), {
    command: 'run',
    envFile: '/tmp/x',
    once: true,
    wait: true,
    flags: {},
  });
  const resolved = parseArgs(['resolve-session', '--repo', 'owner/repo', '--issue', '7', '--no-session']);
  assert.equal(resolved.command, 'resolve-session');
  assert.deepEqual(resolved.flags, { repo: 'owner/repo', issue: '7', noSession: true });
  assert.throws(() => parseArgs(['--env']), ConfigError);
  assert.throws(() => parseArgs(['--env', '--once']), ConfigError);
  assert.throws(() => parseArgs(['--unknown']), ConfigError);
});

test('resolve-session 记录人工核对的 sessionId 或确认无遗留会话', async () => {
  const root = tempDir('fjzx-index-');
  try {
    const { envFile, stateDir } = writeEnv(root);
    const store = new StateStore(stateDir);
    store.load();
    await store.update((draft) => {
      draft.repositories['owner/repo'] = {
        baselineCompleted: true,
        issues: {
          7: { issueBodyHandled: true, binding: { runnerName: 'MB01', sessionId: null, sessionUnresolved: true } },
        },
      };
    });

    const stdout = silentStdout();
    const code = await main(
      ['--env', envFile, 'resolve-session', '--repo', 'owner/repo', '--issue', '7', '--session', 'session-manual'],
      { stdout },
    );
    assert.equal(code, 0);
    assert.match(stdout.text(), /session-manual/);

    const reloaded = new StateStore(stateDir);
    reloaded.load();
    assert.equal(reloaded.read().repositories['owner/repo'].issues['7'].binding.sessionId, 'session-manual');
    assert.equal(reloaded.read().repositories['owner/repo'].issues['7'].binding.sessionUnresolved, false);

    await main(['--env', envFile, 'resolve-session', '--repo', 'owner/repo', '--issue', '7', '--no-session'], {
      stdout: silentStdout(),
    });
    const again = new StateStore(stateDir);
    again.load();
    assert.equal(again.read().repositories['owner/repo'].issues['7'].binding.sessionUnresolved, false);
  } finally {
    cleanup(root);
  }
});

test('resolve-run 释放或维持一个结果不确定的运行', async () => {
  const root = tempDir('fjzx-index-');
  try {
    const { envFile, stateDir } = writeEnv(root);
    const store = new StateStore(stateDir);
    store.load();
    await store.update((draft) => {
      draft.activeRuns['run-x'] = {
        runId: 'run-x',
        repository: 'owner/repo',
        issueNumber: 7,
        status: 'unknown',
        sessionId: null,
        trigger: { sourceType: 'comment', sourceId: '5', at: '2026-09-30T00:00:00.000Z' },
      };
    });

    await main(['--env', envFile, 'resolve-run', '--run', 'run-x', '--outcome', 'exited', '--session', 'session-found'], {
      stdout: silentStdout(),
    });
    const reloaded = new StateStore(stateDir);
    reloaded.load();
    assert.equal(reloaded.read().activeRuns['run-x'].status, 'exited');
    assert.equal(reloaded.read().activeRuns['run-x'].sessionId, 'session-found');

    await main(['--env', envFile, 'resolve-run', '--run', 'run-x', '--outcome', 'running'], {
      stdout: silentStdout(),
    });
    const back = new StateStore(stateDir);
    back.load();
    assert.equal(back.read().activeRuns['run-x'].status, 'running');

    await assert.rejects(
      main(['--env', envFile, 'resolve-run', '--run', 'nope', '--outcome', 'exited'], { stdout: silentStdout() }),
      /未知 runId/,
    );
  } finally {
    cleanup(root);
  }
});

test('--once 遇到读取失败时以非 0 退出，不静默吞掉错误', async () => {
  const root = tempDir('fjzx-index-');
  try {
    const { envFile, stateDir, sourceDir } = writeEnv(root);
    const config = makeConfig({
      stateDir,
      sourceDir,
      repository: { repo: 'owner/repo', sourceDir, worktreeDir: path.join(root, 'wt') },
    });
    const github = createFakeGithub({
      listOpenIssues: () => {
        throw new Error('gh api 失败');
      },
    });
    const stdout = silentStdout();
    const code = await main(['--env', envFile, '--once'], {
      stdout,
      github,
      harness: createFakeHarness(),
      workdir: createFakeWorkdir(),
    });
    assert.equal(code, 1);
    assert.match(stdout.text(), /本轮失败|本轮轮询失败/);
    // 状态文件仍然可读且 baseline 未被标记完成
    const store = new StateStore(stateDir);
    store.load();
    assert.equal(store.read().repositories['owner/repo']?.baselineCompleted ?? false, false);
    assert.ok(config.runnerName);
  } finally {
    cleanup(root);
  }
});

test('未登录 gh 时拒绝启动', async () => {
  const root = tempDir('fjzx-index-');
  try {
    const { envFile } = writeEnv(root);
    const github = createFakeGithub();
    github.authStatus = async () => {
      throw new Error('not logged in');
    };
    await assert.rejects(
      main(['--env', envFile, '--once'], { stdout: silentStdout(), github, harness: createFakeHarness(), workdir: createFakeWorkdir() }),
      /gh auth status 失败/,
    );
  } finally {
    cleanup(root);
  }
});

test('audit 与实例锁由入口管理', async () => {
  const root = tempDir('fjzx-index-');
  try {
    const { envFile, stateDir } = writeEnv(root);
    const github = createFakeGithub();
    const code = await main(['--env', envFile, '--once'], {
      stdout: silentStdout(),
      github,
      harness: createFakeHarness(),
      workdir: createFakeWorkdir(),
    });
    assert.equal(code, 0);
    const audit = fs.readFileSync(path.join(stateDir, 'audit', 'audit.jsonl'), 'utf8');
    assert.match(audit, /runner_started/);
    assert.match(audit, /runner_stopped/);
    assert.equal(fs.existsSync(path.join(stateDir, 'runner.lock')), false, '退出后释放实例锁');
    assert.ok(createFakeAudit().records.length === 0);
  } finally {
    cleanup(root);
  }
});
