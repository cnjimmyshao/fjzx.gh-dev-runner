import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseConfig } from '../src/config.mjs';
import { createRunner } from '../src/runner.mjs';
import { loadState } from '../src/state.mjs';
import { cleanup, comment, issue, makeGh, makeHarnessExec, makeTempDir, withComments } from './helpers.mjs';

/**
 * 跨执行机路由隔离：一份配置里同时接入「归本机」与「归另一台机器」的仓库时，本机必须只处理
 * 属于自己的仓库，不为别的机器创建绑定，也不在别的机器的任务上产生写入者。
 *
 * 这是隔离测试，不等于第二台电脑的实测部署。
 */
const MACHINE = 'mb01';

function buildConfig(root) {
  for (const name of ['task-mb01', 'other-mb01']) mkdirSync(join(root, name), { recursive: true });
  const raw = {
    machineId: MACHINE,
    harness: {
      bin: join(root, 'fake-bin.js'),
      node: process.execPath,
      timeoutMs: 60000,
    },
    runtime: { stateDir: join(root, 'state'), workspaceDir: join(root, 'ws'), pollSeconds: 1 },
    repositories: [
      { repo: 'owner/project', allowedActors: ['maintainer'], repoDir: join(root, 'task-mb01') },
      // 同一台机器上接入的第二个仓库，但被分配给另一台执行机。
      { repo: 'owner/other', machineId: 'mb02', allowedActors: ['maintainer'], repoDir: join(root, 'other-mb01') },
    ],
  };
  return parseConfig(raw, { configPath: join(root, 'config.json') });
}

test('本机只接自己的仓库：别的执行机的仓库不读评论、不启动、不产生绑定', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const config = buildConfig(root);

  const issues = [issue(1, 'runner:mb01'), issue(2, 'runner:mb02')];
  const gh = makeGh({ issues });
  gh.listOpenIssues = async ({ label }) => {
    gh.calls.listOpenIssues++;
    return issues.filter((item) => item.labels.includes(label));
  };
  const { exec, runs } = makeHarnessExec();
  const logs = [];
  const runner = createRunner({ config, gh, exec, log: (message) => logs.push(message) });

  // 第一轮只建立进度基线（首次接入不重放历史命令）；给一条历史评论，让基线有确定的起点。
  const history = [comment(1, '历史讨论')];
  withComments(gh, { 'owner/project#1': history, 'owner/other#2': history });
  await runner.cycle();
  assert.equal(runs.length, 0, '基线轮不启动');

  // 第二轮：两个仓库各有一条新命令；本机只应处理 owner/project。
  withComments(gh, {
    'owner/project#1': [...history, comment(400, '@dev')],
    'owner/other#2': [...history, comment(500, '@dev')],
  });
  await runner.cycle();

  assert.equal(runs.length, 1, '只有归本机的仓库被接单');
  assert.equal(runs[0].cwd, join(root, 'task-mb01'));
  assert.equal(gh.created.length, 1, '只对归本机的 Issue 回写');
  assert.ok(
    logs.some((line) => line.includes('owner/other') && line.includes('machineId=mb02')),
    `别的执行机的仓库被配置跳过：${JSON.stringify(logs)}`,
  );

  const state = loadState(join(config.runtime.stateDir, 'state.json'));
  assert.equal(state.repositories['owner/other'], undefined, '不为别的执行机创建绑定');
  assert.equal(state.repositories['owner/project']['1'].binding.dir, join(root, 'task-mb01'));
});
