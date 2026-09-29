import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ConditionFailed, StateStore, issueState, repositoryState } from '../src/state.js';
import { createRunner } from '../src/runner.js';
import { WorkdirError } from '../src/workdir.js';
import {
  cleanup,
  createFakeAudit,
  createFakeGithub,
  createFakeHarness,
  createFakeWorkdir,
  makeComment,
  makeConfig,
  makeIssue,
  tempDir,
  waitForIdle,
} from './helpers.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

async function setup(options = {}) {
  const stateDir = options.stateDir ?? tempDir('fjzx-state-');
  const config = makeConfig({ stateDir, ...(options.config ?? {}) });
  const store = new StateStore(stateDir);
  store.load();
  const github = createFakeGithub(options.script ?? {});
  const harness = createFakeHarness(options.plan ?? {});
  const workdir = createFakeWorkdir(options.workdirPlan ?? {});
  const audit = createFakeAudit();
  const runner = createRunner({
    config,
    store,
    github,
    harness,
    workdir,
    audit,
    logger: options.logger ?? silent,
  });
  return { stateDir, config, store, github, harness, workdir, audit, runner };
}

async function seedRepository(store, patch = {}) {
  await store.update((draft) => {
    const repo = repositoryState(draft, 'owner/repo');
    repo.baselineCompleted = patch.baselineCompleted ?? true;
    repo.lastScanAt = patch.lastScanAt ?? '2026-09-30T00:00:00Z';
    return undefined;
  });
}

async function seedIssue(store, issueNumber, patch) {
  await store.update((draft) => {
    Object.assign(issueState(draft, 'owner/repo', issueNumber), patch);
  });
}

function issueRecord(store, issueNumber) {
  return store.read().repositories['owner/repo'].issues[String(issueNumber)];
}

function postedBodies(github) {
  return github.calls.filter((call) => call.op === 'postComment').map((call) => call.body);
}

test('首次接入先做 baseline：不回放历史命令，落盘后才进入增量轮询', async () => {
  const ctx = await setup({
    script: {
      listOpenIssues: () => ({
        items: [makeIssue({ number: 5, body: '实现这件事\n\n@MB01', comments: 1 })],
        truncated: false,
      }),
      listRecentComments: () => [makeComment({ id: 77, body: '历史命令 @MB01' })],
      listIssuesSince: () => ({
        items: [makeIssue({ number: 5, body: '实现这件事\n\n@MB01', comments: 1 })],
        truncated: false,
      }),
      listComments: () => ({ items: [makeComment({ id: 77, body: '历史命令 @MB01' })], truncated: false }),
    },
  });
  try {
    await ctx.runner.runCycle();
    assert.equal(ctx.harness.launches.length, 0, 'baseline 不启动 Harness');
    assert.equal(ctx.store.read().repositories['owner/repo'].baselineCompleted, true);
    assert.equal(issueRecord(ctx.store, 5).issueBodyHandled, true);
    assert.equal(issueRecord(ctx.store, 5).commentScanWatermark, '77');
    assert.equal(issueRecord(ctx.store, 5).binding, null);

    // 第二轮：仓库已进入增量轮询，历史命令仍不触发。
    ctx.github.calls.length = 0;
    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);
    assert.equal(ctx.harness.launches.length, 0);
    assert.equal(ctx.github.countOf('listIssuesSince'), 1);
    assert.equal(issueRecord(ctx.store, 5).commentScanWatermark, '77');
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('baseline 分页未完成时不标记完成，下次从头重做', async () => {
  const ctx = await setup({
    script: { listOpenIssues: () => ({ items: [], truncated: true }) },
  });
  try {
    await ctx.runner.runCycle();
    assert.equal(ctx.store.read().repositories['owner/repo'].baselineCompleted, false);
    await ctx.runner.runCycle();
    assert.equal(ctx.github.countOf('listOpenIssues'), 2);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('Issue Body 是命令时一次性领取：水位、binding 与 starting 在同一次更新写入', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 9, body: '做吧\n\n@MB01' })], truncated: false }),
    },
  });
  try {
    await seedRepository(ctx.store);
    const summary = await ctx.runner.runCycle();
    assert.ok(summary.claimed, '本轮领取了一个 Issue');
    await waitForIdle(ctx.runner);

    assert.equal(ctx.harness.launches.length, 1);
    const launch = ctx.harness.launches[0];
    assert.equal(launch.kind, 'start');
    assert.equal(launch.sessionId, null);
    assert.match(launch.task, /\[START\]/);
    assert.match(launch.task, /Issue: #9 https:\/\/github\.com\/owner\/repo\/issues\/9/);
    assert.equal(launch.runDir.endsWith(launch.runId), true);

    const record = issueRecord(ctx.store, 9);
    assert.equal(record.issueBodyHandled, true);
    assert.equal(record.commentScanWatermark, null);
    assert.ok(record.commentScanWatermarkAt, 'Body 领取同时固定评论扫描起点');
    assert.equal(record.lastTrigger.sourceType, 'issue_body');
    assert.equal(record.lastTrigger.author, 'alice');
    assert.equal(record.binding.sessionId, 'session-1');
    assert.equal(record.binding.runnerName, 'MB01');
    assert.equal(record.binding.dir, ctx.workdir.prepared[0].repository.worktreeDir + '/issue-9');

    const run = Object.values(ctx.store.read().activeRuns)[0];
    assert.equal(run.status, 'exited');
    assert.equal(run.outcome, 'turn_completed');
    assert.equal(run.exitCode, 0);

    assert.deepEqual(
      ctx.audit.events().filter((event) => ['trigger_claimed', 'harness_spawned', 'run_end'].includes(event)),
      ['trigger_claimed', 'harness_spawned', 'run_end'],
    );

    // 同一条命令不会因为再次轮询而重复执行
    ctx.harness.launches.length = 0;
    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);
    assert.equal(ctx.harness.launches.length, 0);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('整批评论只领取最新一条有效控制评论，水位随之推进', async () => {
  const comments = [
    makeComment({ id: 11, body: '普通讨论' }),
    makeComment({ id: 12, body: 'BOT:MB01\n已接单，Session ID: session-1' }),
    makeComment({ id: 13, body: '让我来 @MB01', user: { login: 'mallory' } }),
    makeComment({ id: 14, body: '先做这个 @MB01' }),
    makeComment({ id: 15, body: '再做这个 @MB01' }),
  ];
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7, comments: 5 })], truncated: false }),
      listComments: () => ({ items: comments, truncated: false }),
    },
  });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
    });

    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);

    assert.equal(ctx.harness.launches.length, 1);
    const record = issueRecord(ctx.store, 7);
    assert.equal(record.lastTrigger.sourceType, 'comment');
    assert.equal(record.lastTrigger.sourceId, '15');
    assert.equal(record.commentScanWatermark, '15');
    assert.equal(record.binding.sessionId, 'session-1');
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('没有有效控制评论时只推进水位，不启动 Harness', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7 })], truncated: false }),
      listComments: () => ({
        items: [makeComment({ id: 21, body: '讨论' }), makeComment({ id: 22, body: 'BOT:MB01\n反馈' })],
        truncated: false,
      }),
    },
  });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
    });

    await ctx.runner.runCycle();
    assert.equal(ctx.harness.launches.length, 0);
    assert.equal(issueRecord(ctx.store, 7).commentScanWatermark, '22');
    assert.equal(ctx.audit.events().includes('comments_scanned'), true);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('容量不足时本轮不扫描 GitHub，也不消费水位', async () => {
  const ctx = await setup({ plan: { probe: 'alive' } });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
    });
    await ctx.store.update((draft) => {
      draft.activeRuns['run-busy'] = {
        runId: 'run-busy',
        repository: 'owner/repo',
        issueNumber: 7,
        status: 'running',
        pid: 999,
        pidSignature: 'sig',
        startedAt: '2026-09-30T00:00:00.000Z',
        trigger: { sourceType: 'comment', sourceId: '10', at: '2026-09-30T00:00:00.000Z' },
        feedback: { success: false, failure: false },
      };
    });

    await ctx.runner.runCycle();
    assert.equal(ctx.github.calls.length, 0, '机器级满载时不做任何 GitHub 读取');
    assert.equal(issueRecord(ctx.store, 7).commentScanWatermark, '10');
    assert.equal(ctx.harness.launches.length, 0);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('仓库级满载时跳过该仓库，其他仓库继续', async () => {
  const ctx = await setup({
    config: { runtime: { maxConcurrentHarnesses: 3 } },
    plan: { probe: 'alive' },
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7 })], truncated: false }),
    },
  });
  try {
    await seedRepository(ctx.store);
    await ctx.store.update((draft) => {
      draft.activeRuns['run-busy'] = {
        runId: 'run-busy',
        repository: 'owner/repo',
        issueNumber: 7,
        status: 'running',
        pid: 999,
        pidSignature: 'sig',
        startedAt: '2026-09-30T00:00:00.000Z',
        trigger: { sourceType: 'comment', sourceId: '1', at: '2026-09-30T00:00:00.000Z' },
        feedback: {},
      };
    });

    await ctx.runner.runCycle();
    assert.equal(ctx.github.countOf('listIssuesSince'), 0);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('Issue single-flight：运行中的 Issue 不读评论、不推进水位，其他 Issue 照常领取', async () => {
  const ctx = await setup({
    config: {
      runtime: { maxConcurrentHarnesses: 2 },
      repository: { maxConcurrentHarnesses: 2 },
    },
    plan: { probe: 'alive' },
    script: {
      listIssuesSince: () => ({
        items: [makeIssue({ number: 7 }), makeIssue({ number: 8, body: '@MB01' })],
        truncated: false,
      }),
      listComments: () => ({ items: [makeComment({ id: 99, body: '继续 @MB01' })], truncated: false }),
    },
  });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
    });
    await ctx.store.update((draft) => {
      draft.activeRuns['run-live'] = {
        runId: 'run-live',
        repository: 'owner/repo',
        issueNumber: 7,
        status: 'running',
        pid: 999,
        pidSignature: 'sig',
        startedAt: '2026-09-30T00:00:00.000Z',
        trigger: { sourceType: 'comment', sourceId: '10', at: '2026-09-30T00:00:00.000Z' },
        feedback: {},
      };
    });

    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);

    assert.equal(ctx.github.calls.filter((call) => call.op === 'listComments' && call.issueNumber === 7).length, 0);
    assert.equal(issueRecord(ctx.store, 7).commentScanWatermark, '10');
    assert.equal(ctx.harness.launches.length, 1);
    assert.match(ctx.harness.launches[0].task, /Issue: #8/);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('一次 polling cycle 最多领取一个 Issue，领取后仓库游标前进', async () => {
  const ctx = await setup({
    config: {
      runtime: { maxConcurrentHarnesses: 5 },
      repositories: [
        {
          repo: 'owner/repo',
          allowedActors: ['alice'],
          sourceDir: tempDir('fjzx-src-'),
          baseBranch: 'main',
          worktreeDir: tempDir('fjzx-wt-'),
          maxConcurrentHarnesses: 3,
        },
        {
          repo: 'owner/other',
          allowedActors: ['alice'],
          sourceDir: tempDir('fjzx-src-'),
          baseBranch: 'main',
          worktreeDir: tempDir('fjzx-wt-'),
          maxConcurrentHarnesses: 3,
        },
      ],
    },
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7, body: '@MB01' })], truncated: false }),
      listOpenIssues: () => ({ items: [], truncated: false }),
    },
  });
  try {
    await ctx.store.update((draft) => {
      for (const repo of ['owner/repo', 'owner/other']) {
        const record = repositoryState(draft, repo);
        record.baselineCompleted = true;
        record.lastScanAt = '2026-09-30T00:00:00Z';
      }
    });

    const summary = await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);
    assert.equal(ctx.harness.launches.length, 1);
    assert.equal(summary.claimed.repository, 'owner/repo');
    assert.equal(ctx.store.read().scheduler.repoCursor, 1);

    const second = await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);
    assert.equal(ctx.harness.launches.length, 2);
    assert.equal(second.claimed.repository, 'owner/other');
    assert.equal(ctx.store.read().scheduler.repoCursor, 0);
  } finally {
    cleanup(ctx.stateDir);
    cleanup(ctx.config.repositories[1].sourceDir);
    cleanup(ctx.config.repositories[1].worktreeDir);
  }
});

test('候选在读取后被编辑时领取失败并重新读取，不消费水位', async () => {
  let call = 0;
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7 })], truncated: false }),
      listComments: () => {
        call += 1;
        return {
          items: [makeComment({ id: 30, body: '继续 @MB01', updated_at: call === 1 ? 'v1' : 'v2' })],
          truncated: false,
        };
      },
    },
  });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
    });

    await ctx.runner.runCycle();
    assert.equal(ctx.harness.launches.length, 0);
    assert.equal(issueRecord(ctx.store, 7).commentScanWatermark, '10');
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('出现更新的有效控制评论时本次不领取', async () => {
  let call = 0;
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7 })], truncated: false }),
      listComments: () => {
        call += 1;
        return {
          items: [
            makeComment({ id: 30, body: '继续 @MB01' }),
            ...(call === 1 ? [] : [makeComment({ id: 31, body: '换这个 @MB01' })]),
          ],
          truncated: false,
        };
      },
    },
  });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
    });
    await ctx.runner.runCycle();
    assert.equal(ctx.harness.launches.length, 0);
    assert.equal(issueRecord(ctx.store, 7).commentScanWatermark, '10');
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('同 session 第二写入者被拒时判为未启动，并留下最小失败反馈', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7, body: '@MB01' })], truncated: false }),
    },
    plan: {
      entered: false,
      result: {
        exitCode: 1,
        sessionId: null,
        turnEndReason: null,
        hadAssistantCommit: false,
        errorMessage: 'session "session-1" is already owned by an active write handle',
        eventCount: 1,
      },
    },
  });
  try {
    await seedRepository(ctx.store);
    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);

    const run = Object.values(ctx.store.read().activeRuns)[0];
    assert.equal(run.outcome, 'session_busy');
    assert.equal(run.status, 'exited');
    assert.equal(issueRecord(ctx.store, 7).binding.sessionId, null);

    const bodies = postedBodies(ctx.github);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /^BOT:MB01/);
    assert.match(bodies[0], /失败/);
    assert.doesNotMatch(bodies[0], /already owned/);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('START 早期取得 sessionId 后即使本轮未进入可工作 session 也不丢绑定', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7, body: '@MB01' })], truncated: false }),
    },
    plan: {
      entered: false,
      result: {
        exitCode: 1,
        sessionId: 'session-early',
        turnEndReason: 'error',
        hadAssistantCommit: false,
        errorMessage: null,
      },
    },
  });
  try {
    await seedRepository(ctx.store);
    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);

    assert.equal(issueRecord(ctx.store, 7).binding.sessionId, 'session-early');
    const bodies = postedBodies(ctx.github);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /失败/, '未进入可工作 session 时发失败反馈而不是接单确认');
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('退出码 0 但没有有效轮次结束时不冒充完成', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7, body: '@MB01' })], truncated: false }),
    },
    plan: { result: { exitCode: 0, sessionId: 'session-1', turnEndReason: null, hadAssistantCommit: false } },
  });
  try {
    await seedRepository(ctx.store);
    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);
    const run = Object.values(ctx.store.read().activeRuns)[0];
    assert.equal(run.outcome, 'round_failed');
    assert.notEqual(run.outcome, 'turn_completed');
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('RESUME 保持同一 session 与同一工作目录', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7 })], truncated: false }),
      listComments: () => ({ items: [makeComment({ id: 40, body: '继续 @MB01' })], truncated: false }),
    },
  });
  try {
    const dir = `${ctx.config.repositories[0].worktreeDir}/issue-7`;
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
      binding: {
        runnerName: 'MB01',
        dir,
        sessionId: 'session-old',
        branch: 'fjzx/issue-7',
        source: ctx.config.repositories[0].sourceDir,
        worktreeCreated: true,
        createdAt: '2026-09-29T00:00:00.000Z',
      },
    });

    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);

    assert.equal(ctx.harness.launches.length, 1);
    assert.equal(ctx.harness.launches[0].kind, 'resume');
    assert.equal(ctx.harness.launches[0].sessionId, 'session-old');
    assert.equal(ctx.harness.launches[0].dir, dir);
    assert.match(ctx.harness.launches[0].task, /\[RESUME\]/);
    assert.equal(issueRecord(ctx.store, 7).binding.sessionId, 'session-old');
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('绑定不明确时拒绝静默新建并行 session', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7 })], truncated: false }),
      listComments: () => ({ items: [makeComment({ id: 41, body: '继续 @MB01' })], truncated: false }),
    },
  });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
      binding: {
        runnerName: 'MB01',
        dir: `${ctx.config.repositories[0].worktreeDir}/issue-7`,
        sessionId: null,
        sessionUnresolved: true,
        branch: 'fjzx/issue-7',
        source: ctx.config.repositories[0].sourceDir,
        worktreeCreated: true,
        createdAt: '2026-09-29T00:00:00.000Z',
      },
    });

    await ctx.runner.runCycle();
    assert.equal(ctx.harness.launches.length, 0);
    assert.equal(issueRecord(ctx.store, 7).commentScanWatermark, '10');
    const bodies = postedBodies(ctx.github);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /遗留会话/);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('绑定与当前配置不一致时明确停止并报告，不启动 Harness', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7, body: '@MB01' })], truncated: false }),
    },
    workdirPlan: { error: new WorkdirError('dir 与配置不一致', 'binding_config_mismatch') },
  });
  try {
    await seedRepository(ctx.store);
    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);
    assert.equal(ctx.harness.launches.length, 0);
    const run = Object.values(ctx.store.read().activeRuns)[0];
    assert.equal(run.outcome, 'binding_config_mismatch');
    const bodies = postedBodies(ctx.github);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /任务绑定与当前配置不一致/);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('公开失败反馈不泄露本机路径、模型内容或原始错误', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7, body: '@MB01' })], truncated: false }),
    },
    plan: {
      entered: false,
      result: {
        exitCode: null,
        sessionId: null,
        spawnError: { code: 'ENOENT', message: 'spawn /Users/secret/harness TOP-SECRET-MODEL-OUTPUT' },
      },
    },
  });
  try {
    await seedRepository(ctx.store);
    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);
    const bodies = postedBodies(ctx.github);
    assert.equal(bodies.length, 1);
    assert.doesNotMatch(bodies[0], /\/Users\/|TOP-SECRET|ENOENT/);
    assert.match(bodies[0], /Harness 进程未能启动/);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('重启恢复：进程已消失的孤儿运行释放槽位并按证据补发反馈', async () => {
  const stateDir = tempDir('fjzx-state-');
  const ctx = await setup({
    stateDir,
    plan: {
      probe: 'gone',
      capture: { exists: true, sessionId: 'session-7', turnEndReason: 'completed', hadFinal: true, errorMessage: null },
    },
  });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      binding: {
        runnerName: 'MB01',
        dir: '/tmp/task',
        sessionId: null,
        branch: 'fjzx/issue-7',
        source: ctx.config.repositories[0].sourceDir,
        worktreeCreated: true,
        createdAt: '2026-09-30T00:00:00.000Z',
      },
    });
    await ctx.store.update((draft) => {
      draft.activeRuns['run-orphan'] = {
        runId: 'run-orphan',
        repository: 'owner/repo',
        issueNumber: 7,
        status: 'running',
        kind: 'start',
        pid: 555,
        pidSignature: 'sig',
        dir: '/tmp/task',
        runDir: `${stateDir}/runs/run-orphan`,
        sessionId: null,
        startedAt: '2026-09-30T00:00:00.000Z',
        trigger: { sourceType: 'issue_body', sourceId: 'issue-7-body', at: '2026-09-30T00:00:00.000Z' },
        feedback: { success: false, failure: false },
      };
    });

    await ctx.runner.recoverActiveRuns();
    const run = ctx.store.read().activeRuns['run-orphan'];
    assert.equal(run.status, 'exited');
    assert.equal(run.outcome, 'orphan_completed');
    assert.equal(issueRecord(ctx.store, 7).binding.sessionId, 'session-7');
    assert.equal(postedBodies(ctx.github).length, 1);
    assert.match(postedBodies(ctx.github)[0], /Session ID: session-7/);

    // 第二次重启：反馈标记丢失，但 GitHub 上已有对应反馈；回查后不重复发。
    ctx.github.calls.length = 0;
    ctx.github.listRecentComments = async () => [
      makeComment({ id: 900, body: 'BOT:MB01\nMB01 已接单，Session ID: session-7', user: { login: 'MB01' } }),
    ];
    await ctx.store.update((draft) => {
      draft.activeRuns['run-orphan'].status = 'running';
      draft.activeRuns['run-orphan'].feedback = { success: false, failure: false };
    });
    await ctx.runner.recoverActiveRuns();
    assert.equal(ctx.github.countOf('postComment'), 0);
  } finally {
    cleanup(stateDir);
  }
});

test('重启恢复：spawn 结果未确认时保守占槽，不启动第二个写入者', async () => {
  const ctx = await setup({
    script: { listIssuesSince: () => ({ items: [makeIssue({ number: 7, body: '@MB01' })], truncated: false }) },
  });
  try {
    await seedRepository(ctx.store);
    await ctx.store.update((draft) => {
      draft.activeRuns['run-unconfirmed'] = {
        runId: 'run-unconfirmed',
        repository: 'owner/repo',
        issueNumber: 7,
        status: 'starting',
        kind: 'start',
        pid: null,
        pidSignature: null,
        runDir: `${ctx.stateDir}/runs/run-unconfirmed`,
        startedAt: '2026-09-30T00:00:00.000Z',
        trigger: { sourceType: 'issue_body', sourceId: 'issue-7-body', at: '2026-09-30T00:00:00.000Z' },
        feedback: {},
      };
    });

    await ctx.runner.runCycle();
    assert.equal(ctx.store.read().activeRuns['run-unconfirmed'].status, 'unknown');
    assert.equal(ctx.github.calls.length, 0);
    assert.equal(ctx.harness.launches.length, 0);
    assert.equal(machineActive(ctx.store), 1);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('重启恢复：无法确认进程状态时保守标记 unknown 并继续占槽', async () => {
  const ctx = await setup({ plan: { probe: 'unknown' } });
  try {
    await ctx.store.update((draft) => {
      draft.activeRuns['run-x'] = {
        runId: 'run-x',
        repository: 'owner/repo',
        issueNumber: 7,
        status: 'running',
        pid: 777,
        pidSignature: 'sig',
        runDir: `${ctx.stateDir}/runs/run-x`,
        startedAt: '2026-09-30T00:00:00.000Z',
        trigger: { sourceType: 'issue_body', sourceId: 'issue-7-body', at: '2026-09-30T00:00:00.000Z' },
        feedback: {},
      };
    });
    await ctx.runner.recoverActiveRuns();
    assert.equal(ctx.store.read().activeRuns['run-x'].status, 'unknown');
    assert.equal(machineActive(ctx.store), 1);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('未授权作者的新 Issue 不启动 Harness，但一次性 Body 状态仍然落盘', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({
        items: [makeIssue({ number: 7, body: '@MB01', user: { login: 'mallory' } })],
        truncated: false,
      }),
    },
  });
  try {
    await seedRepository(ctx.store);
    await ctx.runner.runCycle();
    assert.equal(ctx.harness.launches.length, 0);
    const record = issueRecord(ctx.store, 7);
    assert.equal(record.issueBodyHandled, true);
    assert.ok(record.commentScanWatermarkAt);
    assert.equal(record.binding, null);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('audit 记录完整可回查的每轮技术信息', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7, body: '@MB01' })], truncated: false }),
    },
  });
  try {
    await seedRepository(ctx.store);
    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);
    const claimed = ctx.audit.records.find((record) => record.event === 'trigger_claimed');
    assert.equal(claimed.repository, 'owner/repo');
    assert.equal(claimed.issueNumber, 7);
    assert.equal(claimed.runnerName, 'MB01');
    assert.equal(claimed.kind, 'start');
    assert.ok(claimed.runId);
    const ended = ctx.audit.records.find((record) => record.event === 'run_end');
    assert.equal(ended.outcome, 'turn_completed');
    assert.equal(ended.sessionId, 'session-1');
    assert.equal(ended.exitCode, 0);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('水位在读取与领取之间被推进时，本次领取条件不成立', async () => {
  let ctx = null;
  let call = 0;
  ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7 })], truncated: false }),
      listComments: async () => {
        call += 1;
        if (call === 2) {
          // 候选校验读取之后、claim 写入之前，另一个执行者把水位推到了别处。
          await ctx.store.update((draft) => {
            const record = issueState(draft, 'owner/repo', 7);
            record.commentScanWatermark = '49';
            record.commentScanWatermarkAt = '2026-09-30T00:00:05.000Z';
          });
        }
        return { items: [makeComment({ id: 50, body: '继续 @MB01' })], truncated: false };
      },
    },
  });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
    });

    await ctx.runner.runCycle();
    assert.equal(ctx.harness.launches.length, 0);
    assert.equal(issueRecord(ctx.store, 7).commentScanWatermark, '49');
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('运行日志按保留上限清理，且不动仍占槽的运行目录', async () => {
  const ctx = await setup({ config: { runtime: { keepRunLogs: 2 } }, plan: { probe: 'alive' } });
  try {
    const runsDir = path.join(ctx.stateDir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const stamp = (name, ageMs) => {
      const dir = path.join(runsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'stdout.jsonl'), '{}\n');
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(dir, when, when);
    };
    stamp('run-oldest', 5_000);
    stamp('run-middle', 3_000);
    stamp('run-newest', 1_000);
    // 仍占槽的运行目录即使最旧也必须保留：子进程还在写。
    stamp('run-active', 9_000);
    await ctx.store.update((draft) => {
      draft.activeRuns['run-active'] = {
        runId: 'run-active',
        repository: 'owner/repo',
        issueNumber: 1,
        status: 'running',
        pid: 999,
        pidSignature: 'sig',
        runDir: path.join(runsDir, 'run-active'),
        startedAt: new Date().toISOString(),
        trigger: { sourceType: 'comment', sourceId: '1', at: new Date().toISOString() },
        feedback: {},
      };
    });

    await ctx.runner.runCycle();
    // 保留上限作用于已结束的运行；仍占槽的运行目录不参与计数、也不会被删。
    const remaining = fs.readdirSync(runsDir).sort();
    assert.deepEqual(remaining, ['run-active', 'run-middle', 'run-newest']);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('并发触发早期判据与结算时，接单确认只发布一次', async () => {
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7, body: '@MB01' })], truncated: false }),
    },
    plan: { entered: true },
  });
  try {
    // 让 GitHub 回查变慢，制造“早期判据回调”和“结算回调”重叠的窗口。
    const original = ctx.github.listRecentComments.bind(ctx.github);
    ctx.github.listRecentComments = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return original(...args);
    };

    await seedRepository(ctx.store);
    await ctx.runner.runCycle();
    await waitForIdle(ctx.runner);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const bodies = postedBodies(ctx.github);
    assert.equal(bodies.length, 1, `接单确认只应发布一次，实际 ${bodies.length} 次`);
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('claim 临界区内复核机器级容量：快照读取后被占满则不领取、不消费水位', async () => {
  let ctx = null;
  const ctxHolder = {};
  ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7 })], truncated: false }),
      listComments: async () => {
        if (ctxHolder.injected !== true) {
          ctxHolder.injected = true;
          await ctx.store.update((draft) => {
            draft.activeRuns['run-other'] = {
              runId: 'run-other',
              repository: 'owner/other',
              issueNumber: 1,
              status: 'running',
              pid: 4321,
              pidSignature: 'sig',
              startedAt: new Date().toISOString(),
              trigger: { sourceType: 'comment', sourceId: '1', at: new Date().toISOString() },
              feedback: {},
            };
          });
        }
        return { items: [makeComment({ id: 60, body: '继续 @MB01' })], truncated: false };
      },
    },
  });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
    });

    await ctx.runner.runCycle();
    assert.equal(ctx.harness.launches.length, 0);
    assert.equal(issueRecord(ctx.store, 7).commentScanWatermark, '10');
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('claim 临界区内复核仓库级容量：同仓库槽位被占满则不领取', async () => {
  let ctx = null;
  const holder = {};
  ctx = await setup({
    config: { runtime: { maxConcurrentHarnesses: 3 }, repository: { maxConcurrentHarnesses: 1 } },
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7 })], truncated: false }),
      listComments: async () => {
        if (holder.injected !== true) {
          holder.injected = true;
          await ctx.store.update((draft) => {
            draft.activeRuns['run-same-repo'] = {
              runId: 'run-same-repo',
              repository: 'owner/repo',
              issueNumber: 9,
              status: 'starting',
              pid: null,
              startedAt: new Date().toISOString(),
              trigger: { sourceType: 'comment', sourceId: '2', at: new Date().toISOString() },
              feedback: {},
            };
          });
        }
        return { items: [makeComment({ id: 61, body: '继续 @MB01' })], truncated: false };
      },
    },
  });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
    });

    await ctx.runner.runCycle();
    assert.equal(ctx.harness.launches.length, 0);
    assert.equal(issueRecord(ctx.store, 7).commentScanWatermark, '10');
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('绑定不明确时的拒绝反馈不会每轮重复刷同一条评论', async () => {
  const posted = [];
  const ctx = await setup({
    script: {
      listIssuesSince: () => ({ items: [makeIssue({ number: 7 })], truncated: false }),
      listComments: () => ({ items: [makeComment({ id: 70, body: '继续 @MB01' })], truncated: false }),
      listRecentComments: () => posted.map((body, index) => ({ id: 900 + index, body, created_at: '2026-09-30T00:00:00Z' })),
    },
  });
  try {
    ctx.github.postComment = async (repo, issueNumber, body) => {
      posted.push(body);
    };
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      commentScanWatermark: '10',
      commentScanWatermarkAt: '2026-09-30T00:00:00.000Z',
      binding: {
        runnerName: 'MB01',
        dir: `${ctx.config.repositories[0].worktreeDir}/issue-7`,
        sessionId: null,
        sessionUnresolved: true,
        branch: 'fjzx/issue-7',
        source: ctx.config.repositories[0].sourceDir,
        worktreeCreated: true,
        createdAt: '2026-09-29T00:00:00.000Z',
      },
    });

    for (let round = 0; round < 3; round += 1) {
      await ctx.runner.runCycle();
    }
    assert.equal(posted.length, 1, `三轮只应提示一次，实际 ${posted.length} 次`);
    assert.equal(issueRecord(ctx.store, 7).commentScanWatermark, '10');
  } finally {
    cleanup(ctx.stateDir);
  }
});

test('重启恢复：只有 sessionId 而没有已提交助手内容时按未进入可工作 session 处理', async () => {
  const stateDir = tempDir('fjzx-state-');
  const ctx = await setup({
    stateDir,
    plan: {
      probe: 'gone',
      capture: {
        exists: true,
        sessionId: 'session-lost',
        turnEndReason: null,
        hadFinal: false,
        hadAssistantCommit: false,
        errorMessage: null,
      },
    },
  });
  try {
    await seedRepository(ctx.store);
    await seedIssue(ctx.store, 7, {
      issueBodyHandled: true,
      binding: {
        runnerName: 'MB01',
        dir: '/tmp/task',
        sessionId: null,
        branch: 'fjzx/issue-7',
        source: ctx.config.repositories[0].sourceDir,
        worktreeCreated: true,
        createdAt: '2026-09-30T00:00:00.000Z',
      },
    });
    await ctx.store.update((draft) => {
      draft.activeRuns['run-lost'] = {
        runId: 'run-lost',
        repository: 'owner/repo',
        issueNumber: 7,
        status: 'running',
        kind: 'start',
        pid: 556,
        pidSignature: 'sig',
        dir: '/tmp/task',
        runDir: `${stateDir}/runs/run-lost`,
        sessionId: null,
        startedAt: '2026-09-30T00:00:00.000Z',
        trigger: { sourceType: 'issue_body', sourceId: 'issue-7-body', at: '2026-09-30T00:00:00.000Z' },
        feedback: { success: false, failure: false },
      };
    });

    await ctx.runner.recoverActiveRuns();
    const run = ctx.store.read().activeRuns['run-lost'];
    assert.equal(run.status, 'exited');
    assert.equal(run.outcome, 'orphan_lost');
    assert.equal(issueRecord(ctx.store, 7).binding.sessionId, 'session-lost');

    const bodies = postedBodies(ctx.github);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /失败/);
    assert.doesNotMatch(bodies[0], /已接单/);
  } finally {
    cleanup(stateDir);
  }
});

function machineActive(store) {
  return Object.values(store.read().activeRuns).filter((run) =>
    ['starting', 'running', 'unknown'].includes(run.status),
  ).length;
}
