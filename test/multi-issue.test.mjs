import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createRunner } from '../src/runner.mjs';
import { loadState } from '../src/state.mjs';
import { baseConfig, cleanup, comment, issue, makeGh, makeHarnessExec, makeTempDir, withComments } from './helpers.mjs';

const LABEL = 'runner:mb01';

/**
 * 一个仓库里同时有两个待办 Issue：各自的绑定与 `inFlight` 这类单任务标记不能在 Issue 之间串味
 * （否则下一条命令会被误判为「执行中」）。
 *
 * 只配 `repoDir` 时两个 Issue 会指向同一目录，因此第二个任务应当被明确拒绝（见下面的用例）。
 */
test('同仓库两个 Issue 的绑定与执行中标记互不影响', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const dirs = { 1: join(root, 'task-a'), 2: join(root, 'task-b') };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const { config } = baseConfig({
    root,
    overrides: {
      repositories: [
        { repo: 'owner/project', allowedActors: ['maintainer'], repoDir: dirs[1] },
        { repo: 'owner/other', allowedActors: ['maintainer'], repoDir: dirs[2] },
      ],
    },
  });

  const issues = [issue(1, LABEL)];
  const gh = makeGh({ issues });
  gh.listOpenIssues = async ({ label }) => issues.filter((item) => item.labels.includes(label));
  const { exec, runs } = makeHarnessExec();
  const runner = createRunner({ config, gh, exec, log: () => {} });
  const stateFile = join(config.runtime.stateDir, 'state.json');

  const history = [comment(10, '历史')];
  withComments(gh, { 'owner/project#1': history });
  await runner.cycle();
  assert.equal(runs.length, 0, '基线轮不启动');

  withComments(gh, { 'owner/project#1': [...history, comment(100, '@dev')] });
  await runner.cycle();
  assert.equal(runs.length, 1, '有命令的 Issue 执行一次');
  assert.equal(runs[0].cwd, dirs[1]);
  const state = loadState(stateFile).repositories['owner/project'];
  assert.equal(state['1'].inFlight, false, '调用结束后不留下执行中标记');

  // 再跑一轮：没有新命令，不应重复执行，也不应被残留标记影响。
  await runner.cycle();
  assert.equal(runs.length, 1, '没有新命令就不重复执行');
});

/**
 * `repoDir` 模式下，同一仓库的第二个任务会与第一个共用目录 —— 必须在启动前拒绝并在 Issue 回报，
 * 否则两个任务会在同一份检出上并行开发。
 */
test('同一目录上的第二个任务被拒绝，不悄悄共用工作目录', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const shared = join(root, 'shared-task-root');
  mkdirSync(shared, { recursive: true });
  const { config } = baseConfig({
    root,
    overrides: {
      repositories: [
        { repo: 'owner/project', allowedActors: ['maintainer'], repoDir: shared },
      ],
    },
  });

  const issues = [issue(1, LABEL), issue(2, LABEL)];
  const gh = makeGh({ issues });
  gh.listOpenIssues = async ({ label }) => issues.filter((item) => item.labels.includes(label));
  const { exec, runs } = makeHarnessExec();
  const runner = createRunner({ config, gh, exec, log: () => {} });

  const history = [comment(10, '历史')];
  withComments(gh, { 'owner/project#1': history, 'owner/project#2': history });
  await runner.cycle();

  // Issue #1 先占用共享目录。
  withComments(gh, {
    'owner/project#1': [...history, comment(100, '@dev')],
    'owner/project#2': history,
  });
  await runner.cycle();
  assert.equal(runs.length, 1);

  // Issue #2 随后也拿到命令：必须被拒绝，而不是共用同一个目录。
  withComments(gh, {
    'owner/project#1': [...history, comment(100, '@dev')],
    'owner/project#2': [...history, comment(200, '@dev')],
  });
  await runner.cycle();
  assert.equal(runs.length, 1, '不启动第二个共用目录的任务');
  const refusal = gh.created.find((item) => item.issueNumber === 2);
  assert.ok(refusal !== undefined, '在 Issue #2 上回报未启动');
  assert.match(refusal.body, /已被同一仓库的 Issue #1 占用/);
  assert.match(refusal.body, /sourceDir/);
});

/**
 * 同一轮里两个 Issue 各有一条新命令：两个都要被受理（一个任务一次调用，不同任务是不同任务），
 * 且各自的回写只落在自己的 Issue 上。
 */
test('同一轮里两个 Issue 各有一条命令，都会被执行且回写各自 Issue', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const dirA = join(root, 'task-a');
  const dirB = join(root, 'task-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const { config } = baseConfig({
    root,
    overrides: {
      repositories: [
        { repo: 'owner/project', allowedActors: ['maintainer'], repoDir: dirA },
        { repo: 'owner/other', allowedActors: ['maintainer'], repoDir: dirB },
      ],
    },
  });

  const issues = [issue(1, LABEL), issue(2, LABEL)];
  const gh = makeGh({ issues });
  gh.listOpenIssues = async ({ label }) => issues.filter((item) => item.labels.includes(label));
  const { exec, runs } = makeHarnessExec();
  const runner = createRunner({ config, gh, exec, log: () => {} });

  const history = [comment(10, '历史')];
  withComments(gh, { 'owner/project#1': history, 'owner/other#2': history });
  await runner.cycle();

  withComments(gh, {
    'owner/project#1': [...history, comment(300, '@dev')],
    'owner/other#2': [...history, comment(301, '@dev')],
  });
  await runner.cycle();

  assert.equal(runs.length, 2, '两个不同任务各执行一次');
  const written = gh.created.map((item) => `${item.repo}#${item.issueNumber}`);
  assert.deepEqual(written.sort(), ['owner/other#2', 'owner/project#1'], '回写落在各自 Issue');
  assert.ok(gh.created.every((item) => /已接单：新建 Harness 会话/.test(item.body)));
});
