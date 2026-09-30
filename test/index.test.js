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
    const auditText = fs.readFileSync(path.join(stateDir, 'audit', 'audit.jsonl'), 'utf8');
    assert.match(auditText, /"event":"manual_resolution"/);
    assert.match(auditText, /"command":"resolve-session"/);
    // sessionId 由 Contract 要求在接单确认里公开，本机审计记录它用于“谁确认了哪个会话”的回查。
    assert.match(auditText, /"sessionRecorded":"session-manual"/);
    assert.doesNotMatch(auditText, /已接单|BOT:/, '审计不复制 GitHub 反馈正文');

    await main(['--env', envFile, 'resolve-session', '--repo', 'owner/repo', '--issue', '7', '--no-session'], {
      stdout: silentStdout(),
    });
    const again = new StateStore(stateDir);
    again.load();
    const after = again.read().repositories['owner/repo'].issues['7'].binding;
    assert.equal(after.sessionUnresolved, false);
    assert.equal(after.sessionId, null, '--no-session 同时清除旧标识，下一次触发按 START');
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
        // 人工把运行标回 running 需要可核对的进程身份，否则恢复逻辑无法维持该状态。
        pid: 4242,
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

test('resolve-run 拒绝把没有可核对 pid 的运行人工标回 running', async () => {
  const root = tempDir('fjzx-index-');
  try {
    const { envFile, stateDir } = writeEnv(root);
    const store = new StateStore(stateDir);
    store.load();
    await store.update((draft) => {
      draft.activeRuns['run-nopid'] = {
        runId: 'run-nopid',
        repository: 'owner/repo',
        issueNumber: 7,
        status: 'unknown',
        pid: null,
        sessionId: null,
        trigger: { sourceType: 'comment', sourceId: '5', at: '2026-09-30T00:00:00.000Z' },
      };
    });

    // 没有可核对的进程身份就无法维持 running：重启恢复会立刻把它归一为 unknown（src/runner.js），
    // 而 unknown 同样占槽（src/state.js），所以保留 unknown 不损失容量，也不该伪造确定状态。
    await assert.rejects(
      main(['--env', envFile, 'resolve-run', '--run', 'run-nopid', '--outcome', 'running'], {
        stdout: silentStdout(),
      }),
      /没有可核对的 pid/,
    );
    const rejected = new StateStore(stateDir);
    rejected.load();
    assert.equal(rejected.read().activeRuns['run-nopid'].status, 'unknown', '被拒绝的恢复不改变运行状态');
    assert.equal(rejected.read().activeRuns['run-nopid'].manualResolution, undefined, '被拒绝的恢复不写人工动作');

    // 释放槽位这条路径不需要 pid，仍然可用。
    await main(['--env', envFile, 'resolve-run', '--run', 'run-nopid', '--outcome', 'exited'], {
      stdout: silentStdout(),
    });
    const released = new StateStore(stateDir);
    released.load();
    assert.equal(released.read().activeRuns['run-nopid'].status, 'exited');
  } finally {
    cleanup(root);
  }
});

test('resolve-run --outcome exited 按 CAPTURE 收敛该运行的捕获', async () => {
  const root = tempDir('fjzx-index-');
  try {
    const { envFile, stateDir } = writeEnv(root);
    const runDir = path.join(stateDir, 'runs', 'run-capture');
    fs.mkdirSync(runDir, { recursive: true });
    // 原始捕获：技术事件 + 模型正文 + stderr，模拟一次遗留 unknown 运行的现场。
    fs.writeFileSync(
      path.join(runDir, 'stdout.jsonl'),
      [
        JSON.stringify({ type: 'session', sessionId: 'session-cap' }),
        JSON.stringify({ type: 'text', text: 'MODEL-TEXT-MUST-NOT-STAY' }),
        JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } }),
        JSON.stringify({ type: 'final', text: 'MODEL-TEXT-MUST-NOT-STAY' }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(runDir, 'stderr.log'), 'diagnostics');

    const store = new StateStore(stateDir);
    store.load();
    await store.update((draft) => {
      draft.activeRuns['run-capture'] = {
        runId: 'run-capture',
        repository: 'owner/repo',
        issueNumber: 7,
        status: 'unknown',
        pid: null,
        sessionId: null,
        runDir,
        trigger: { sourceType: 'comment', sourceId: '5', at: '2026-09-30T00:00:00.000Z' },
      };
    });

    await main(['--env', envFile, 'resolve-run', '--run', 'run-capture', '--outcome', 'exited'], {
      stdout: silentStdout(),
    });

    const capture = fs.readFileSync(path.join(runDir, 'stdout.jsonl'), 'utf8');
    assert.match(capture, /"type":"session"/);
    assert.match(capture, /"phase":"turn_end"/);
    assert.doesNotMatch(capture, /MODEL-TEXT-MUST-NOT-STAY/, 'metadata 不长期保留模型正文');
    assert.equal(fs.existsSync(path.join(runDir, 'stderr.log')), false, 'metadata 不长期保留 stderr 捕获');
  } finally {
    cleanup(root);
  }
});

test('resolve-run --outcome running 不收敛仍可能被写入的捕获', async () => {
  const root = tempDir('fjzx-index-');
  try {
    const { envFile, stateDir } = writeEnv(root);
    const runDir = path.join(stateDir, 'runs', 'run-live');
    fs.mkdirSync(runDir, { recursive: true });
    const original = [
      JSON.stringify({ type: 'session', sessionId: 'session-live' }),
      JSON.stringify({ type: 'text', text: 'STILL-WRITING' }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(runDir, 'stdout.jsonl'), original);
    fs.writeFileSync(path.join(runDir, 'stderr.log'), 'diagnostics');

    const store = new StateStore(stateDir);
    store.load();
    await store.update((draft) => {
      draft.activeRuns['run-live'] = {
        runId: 'run-live',
        repository: 'owner/repo',
        issueNumber: 7,
        status: 'unknown',
        pid: 4242,
        sessionId: null,
        runDir,
        trigger: { sourceType: 'comment', sourceId: '5', at: '2026-09-30T00:00:00.000Z' },
      };
    });

    await main(['--env', envFile, 'resolve-run', '--run', 'run-live', '--outcome', 'running'], {
      stdout: silentStdout(),
    });

    assert.equal(fs.readFileSync(path.join(runDir, 'stdout.jsonl'), 'utf8'), original, '运行仍在写时不得截断捕获');
    assert.equal(fs.existsSync(path.join(runDir, 'stderr.log')), true);
  } finally {
    cleanup(root);
  }
});

test('resolve-binding --take-ownership 由维护者显式迁移绑定', async () => {
  const root = tempDir('fjzx-index-');
  try {
    const { envFile, stateDir, sourceDir } = writeEnv(root);
    const store = new StateStore(stateDir);
    store.load();
    await store.update((draft) => {
      draft.repositories['owner/repo'] = {
        baselineCompleted: true,
        issues: {
          7: {
            issueBodyHandled: true,
            binding: {
              runnerName: 'HZ01',
              dir: '/elsewhere/issue-7',
              sessionId: 'session-hz',
              branch: 'fjzx/issue-7',
              source: '/elsewhere',
              worktreeCreated: true,
              createdAt: '2026-09-29T00:00:00.000Z',
            },
          },
        },
      };
    });

    await assert.rejects(
      main(['--env', envFile, 'resolve-binding', '--repo', 'owner/repo', '--issue', '7'], { stdout: silentStdout() }),
      /take-ownership/,
    );

    const code = await main(
      ['--env', envFile, 'resolve-binding', '--repo', 'owner/repo', '--issue', '7', '--take-ownership'],
      { stdout: silentStdout() },
    );
    assert.equal(code, 0);
    const reloaded = new StateStore(stateDir);
    reloaded.load();
    const binding = reloaded.read().repositories['owner/repo'].issues['7'].binding;
    assert.equal(binding.runnerName, 'MB01');
    assert.equal(binding.sessionId, null, '迁移后不续接原机器的会话');
    assert.equal(binding.source, sourceDir);
    assert.match(binding.dir, /issue-7$/);
  } finally {
    cleanup(root);
  }
});

test('--once 遇到读取失败时以非 0 退出，不静默吞掉错误', { skip: process.versions.node.split('.')[0] !== '24' && 'Runner 只支持 Node 24（engines.node = 24.x）' }, async () => {
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

test('未登录 gh 时拒绝启动', { skip: process.versions.node.split('.')[0] !== '24' && 'Runner 只支持 Node 24（engines.node = 24.x）' }, async () => {
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

test('本进程仍有运行在飞时不释放实例锁', {
  skip: process.versions.node.split('.')[0] !== '24' && 'Runner 只支持 Node 24（engines.node = 24.x）',
}, async () => {
  const root = tempDir('fjzx-index-');
  try {
    const { envFile, stateDir, sourceDir } = writeEnv(root);
    let release = null;
    const exitGate = new Promise((resolve) => {
      release = resolve;
    });
    const launches = [];
    const slowHarness = {
      ...createFakeHarness(),
      launch(input) {
        launches.push(input);
        return {
          pid: 4242,
          record: { sessionMismatch: false },
          sessionId: Promise.resolve('session-slow'),
          earlySignal: Promise.resolve(false),
          exited: exitGate.then(() => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            spawnError: null,
            sessionId: 'session-slow',
            sessionMismatch: false,
            turnEndReason: 'completed',
            hadAssistantCommit: true,
            hadFinal: true,
            errorMessage: null,
            invalidLines: 0,
            eventCount: 2,
            runDir: input.runDir,
          })),
        };
      },
    };
    const github = createFakeGithub({
      listIssuesSince: () => ({
        items: [{ number: 7, body: '@MB01', user: { login: 'alice' }, comments: 0, updated_at: 'x' }],
        truncated: false,
      }),
    });

    const pending = main(['--env', envFile, '--once'], {
      stdout: silentStdout(),
      github,
      harness: slowHarness,
      workdir: createFakeWorkdir(),
    });
    while (launches.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      fs.existsSync(path.join(stateDir, 'runner.lock')),
      true,
      '本进程仍需在子进程结束后写状态，锁必须保留',
    );

    release();
    const code = await pending;
    assert.equal(code, 0);
    assert.equal(
      fs.existsSync(path.join(stateDir, 'runner.lock')),
      false,
      '没有在飞运行后释放锁，允许正常重启',
    );
    assert.ok(sourceDir);
  } finally {
    cleanup(root);
  }
});

test('audit 与实例锁由入口管理', { skip: process.versions.node.split('.')[0] !== '24' && 'Runner 只支持 Node 24（engines.node = 24.x）' }, async () => {
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
