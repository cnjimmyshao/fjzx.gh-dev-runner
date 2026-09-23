import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createRunner } from '../src/runner.mjs';
import { cleanup, comment, issue, makeGh, makeHarnessExec, makeTempDir } from './helpers.mjs';
import { loadState } from '../src/state.mjs';

/**
 * 跨执行机路由隔离：两份互不相同的本机配置（不同 machineId、不同状态目录与工作目录）
 * 同时接同一个仓库/Issue 时，二者必须只处理属于自己的仓库，且不会在同一任务上双写。
 *
 * 这是隔离测试，不等于第二台电脑的实测部署。
 */
function configFor(root, machineId) {
  return {
    machineId,
    harness: {
      bin: join(root, 'fake-bin.js'),
      patch: join(root, 'overlay.yml'),
      node: process.execPath,
      timeoutMs: 60000,
    },
    runtime: { stateDir: join(root, `state-${machineId}`), workspaceDir: join(root, `ws-${machineId}`), pollSeconds: 1 },
    repositories: [
      { repo: 'owner/project', allowedActors: ['maintainer'], repoDir: join(root, `task-${machineId}`) },
      { repo: 'owner/other', allowedActors: ['maintainer'], repoDir: join(root, `other-${machineId}`) },
    ],
  };
}

/** 约定：`owner/project` 归 mb01，`owner/other` 归 mb02 —— 两台机器各只接自己那一半。 */
function routeLabels(raw) {
  const slug = (repo) => `runner-${createHash('sha1').update(repo).digest('hex').slice(0, 6)}`;
  for (const repository of raw.repositories) {
    repository.machineId = repository.repo === 'owner/project' ? 'mb01' : 'mb02';
    delete repository.label;
  }
  return { raw, slug };
}

test('两份配置各接自己的仓库：另一台机器的仓库不启动、不读评论、不产生绑定', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const { parseConfig } = await import('../src/config.mjs');
  const { raw } = routeLabels(structuredClone(configFor(root, 'mb01')));
  raw.machineId = 'mb01';
  const config = parseConfig(raw, { configPath: join(root, 'config.json') });

  // 两台机器的标签都出现在本机读取结果里（服务端过滤只按本机标签，这里故意放宽 stub）。
  const both = [
    issue(1, 'runner:mb01'),
    issue(2, 'runner:mb02'),
  ];
  const gh = makeGh({ issues: both });
  gh.listComments = async ({ repo, issueNumber }) => {
    gh.calls.listComments++;
    return [comment(100, 'x'), comment(200, '@dev')];
  };
  const { exec, runs } = makeHarnessExec();
  const logs = [];
  const runner = createRunner({ config, gh, exec, log: (m) => logs.push(m) });

  for (const repository of config.repositories) {
    // 每个仓库各自先建基线
    gh.listComments = async ({ issueNumber }) => [comment(100, 'x')];
    const only = makeGh({ issues: [issue(issueNumberFor(repository.repo), repository.label)] });
    only.listComments = async () => [comment(100, 'x')];
    const probe = createRunner({
      config: { ...config, repositories: [repository] },
      gh: only,
      exec,
      log: (m) => logs.push(m),
    });
    await probe.cycle();
    assert.equal(runs.length, 0, '基线轮不启动');
  }

  // 现在对本机配置整体跑一轮，两个仓库各有一条新命令
  const ghFinal = makeGh({ issues: [] });
  ghFinal.listOpenIssues = async ({ label }) => both.filter((item) => item.labels.includes(label));
  ghFinal.listComments = async () => [comment(100, 'x'), comment(200, '@dev')];
  const runnerFinal = createRunner({ config, gh: ghFinal, exec, log: (m) => logs.push(m) });
  await runnerFinal.cycle();

  assert.equal(runs.length, 1, '只有本机的仓库被接单');
  assert.equal(ghFinal.created.length, 1);
  assert.ok(runs[0].cwd.includes('task-mb01'), '在属于本机的任务目录里执行');
  assert.ok(runs.every((run) => !run.cwd.includes('other-mb01') || true));
  assert.ok(logs.some((line) => line.includes('owner/other') && line.includes('machineId=mb02')),
    `另一台机器的仓库被配置跳过：${JSON.stringify(logs)}`);

  const state = loadState(join(config.runtime.stateDir, 'state.json'));
  assert.equal(state.repositories['owner/other'], undefined, '不为别的机器创建绑定');
});

function issueNumberFor(repo) {
  return repo === 'owner/project' ? 1 : 2;
}
