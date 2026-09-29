import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ConditionFailed,
  StateError,
  StateStore,
  activeRunForIssue,
  createEmptyState,
  issueState,
  machineActiveCount,
  pruneEndedRuns,
  repoActiveCount,
} from '../src/state.js';
import { cleanup, tempDir } from './helpers.js';

test('文件不存在视为首次接入', () => {
  const dir = tempDir();
  try {
    const store = new StateStore(dir);
    const state = store.load();
    assert.equal(state.version, 1);
    assert.deepEqual(state.activeRuns, {});
    assert.deepEqual(state.repositories, {});
  } finally {
    cleanup(dir);
  }
});

test('状态写入是原子替换，重新加载得到同一内容', async () => {
  const dir = tempDir();
  try {
    const store = new StateStore(dir);
    store.load();
    await store.update((draft) => {
      issueState(draft, 'owner/repo', 42).issueBodyHandled = true;
    });
    const reloaded = new StateStore(dir);
    reloaded.load();
    assert.equal(reloaded.read().repositories['owner/repo'].issues['42'].issueBodyHandled, true);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp')), []);
  } finally {
    cleanup(dir);
  }
});

test('状态损坏、为空或版本不支持时拒绝覆盖', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '');
    assert.throws(() => new StateStore(dir).load(), StateError);

    fs.writeFileSync(file, '{ not json');
    assert.throws(() => new StateStore(dir).load(), StateError);

    fs.writeFileSync(file, JSON.stringify({ version: 99, activeRuns: {}, repositories: {} }));
    assert.throws(() => new StateStore(dir).load(), /version/);

    fs.writeFileSync(file, JSON.stringify({ version: 1, activeRuns: [], repositories: {} }));
    assert.throws(() => new StateStore(dir).load(), StateError);
    // 没有被静默覆盖
    assert.equal(fs.readFileSync(file, 'utf8').includes('"version":1'), true);
  } finally {
    cleanup(dir);
  }
});

test('条件式更新失败时不写盘，且更新串行执行', async () => {
  const dir = tempDir();
  try {
    const store = new StateStore(dir);
    store.load();
    await store.update((draft) => {
      issueState(draft, 'owner/repo', 7).commentScanWatermark = '10';
    });

    await assert.rejects(
      store.update((draft) => {
        const record = issueState(draft, 'owner/repo', 7);
        if (record.commentScanWatermark !== '999') throw new ConditionFailed('watermark_moved');
        record.commentScanWatermark = '1234';
      }),
      ConditionFailed,
    );
    assert.equal(store.read().repositories['owner/repo'].issues['7'].commentScanWatermark, '10');

    const order = [];
    await Promise.all([
      store.update((draft) => {
        order.push('a');
        issueState(draft, 'owner/repo', 1).issueBodyHandled = true;
      }),
      store.update((draft) => {
        order.push('b');
        issueState(draft, 'owner/repo', 2).issueBodyHandled = true;
      }),
    ]);
    assert.deepEqual(order, ['a', 'b']);
    assert.equal(store.read().repositories['owner/repo'].issues['1'].issueBodyHandled, true);
    assert.equal(store.read().repositories['owner/repo'].issues['2'].issueBodyHandled, true);
  } finally {
    cleanup(dir);
  }
});

test('临界区内的 mutator 不得 await', async () => {
  const dir = tempDir();
  try {
    const store = new StateStore(dir);
    store.load();
    await assert.rejects(store.update(async () => {}), /同步完成/);
  } finally {
    cleanup(dir);
  }
});

test('容量记账只统计 starting / running / unknown', () => {
  const state = createEmptyState();
  state.activeRuns = {
    a: { runId: 'a', repository: 'owner/repo', issueNumber: 1, status: 'running' },
    b: { runId: 'b', repository: 'owner/repo', issueNumber: 2, status: 'starting' },
    c: { runId: 'c', repository: 'owner/other', issueNumber: 3, status: 'unknown' },
    d: { runId: 'd', repository: 'owner/repo', issueNumber: 4, status: 'exited' },
  };
  assert.equal(machineActiveCount(state), 3);
  assert.equal(repoActiveCount(state, 'owner/repo'), 2);
  assert.equal(repoActiveCount(state, 'owner/other'), 1);
  assert.equal(activeRunForIssue(state, 'owner/repo', 1).runId, 'a');
  assert.equal(activeRunForIssue(state, 'owner/repo', 4), null);
});

test('已结束的运行记录超过保留期后被清理，仍占槽的不动', () => {
  const now = Date.now();
  const state = createEmptyState();
  state.activeRuns = {
    old: {
      runId: 'old',
      repository: 'owner/repo',
      issueNumber: 1,
      status: 'exited',
      startedAt: new Date(now - 10 * 24 * 3600 * 1000).toISOString(),
      endedAt: new Date(now - 10 * 24 * 3600 * 1000).toISOString(),
    },
    fresh: {
      runId: 'fresh',
      repository: 'owner/repo',
      issueNumber: 2,
      status: 'exited',
      startedAt: new Date(now - 3600 * 1000).toISOString(),
      endedAt: new Date(now - 3600 * 1000).toISOString(),
    },
    live: {
      runId: 'live',
      repository: 'owner/repo',
      issueNumber: 3,
      status: 'running',
      startedAt: new Date(now - 10 * 24 * 3600 * 1000).toISOString(),
    },
  };
  pruneEndedRuns(state, now);
  assert.deepEqual(Object.keys(state.activeRuns).sort(), ['fresh', 'live']);
});
