import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createRunner } from '../src/runner.mjs';
import { loadState } from '../src/state.mjs';
import { baseConfig, cleanup, comment, issue, makeGh, makeHarnessExec, makeTempDir, withComments } from './helpers.mjs';

const LABEL = 'runner:mb01';

function setup({ gh: ghOptions = {}, harness = {} } = {}) {
  const root = makeTempDir();
  const { config } = baseConfig({ root });
  const gh = makeGh({ issues: [issue(1, LABEL)], ...ghOptions });
  const { exec, runs } = makeHarnessExec(harness);
  const logs = [];
  const runner = createRunner({ config, gh, exec, log: (message) => logs.push(message) });
  const stateFile = join(config.runtime.stateDir, 'state.json');
  return { root, config, gh, exec, runs, logs, runner, stateFile };
}

function entry(ctx, issueNumber = 1) {
  return loadState(ctx.stateFile).repositories['owner/project'][String(issueNumber)];
}

/** 先跑一轮空基线，再追加命令；返回时 gh 会返回「历史 + 新命令」。 */
async function withNewCommand(ctx, command, history = [comment(100, 'x')]) {
  withComments(ctx.gh, { 'owner/project#1': history });
  await ctx.runner.cycle();
  withComments(ctx.gh, { 'owner/project#1': [...history, command] });
  await ctx.runner.cycle();
}

test('尚无评论的 Issue：首条评论就是命令时必须接单', async (t) => {
  const ctx = setup();
  t.after(() => cleanup(ctx.root));

  // 建 Issue → 立刻发命令是最常见的接入顺序：此时该 Issue 一条评论都没有，
  // 扫描到的基线是 0，不能被当成「还没初始化」而把这条命令吞掉。
  withComments(ctx.gh, { 'owner/project#1': [] });
  await ctx.runner.cycle();
  assert.equal(ctx.runs.length, 0, '空 Issue 的第一轮不启动');
  assert.equal(entry(ctx).seenSeq, 0, '空 Issue 的基线是 0，且已初始化');

  withComments(ctx.gh, { 'owner/project#1': [comment(100, '@dev')] });
  await ctx.runner.cycle();
  assert.equal(ctx.runs.length, 1, '首条评论恰好是命令时也要接单');
  assert.equal(ctx.gh.created.length, 1);
  assert.match(ctx.gh.created[0].body, /已接单：新建 Harness 会话/);

  // 再跑一轮不应重复。
  await ctx.runner.cycle();
  assert.equal(ctx.runs.length, 1, '不重复执行');
});

test('首次接入把历史命令登记为已看过，不启动 Harness', async (t) => {
  const ctx = setup();
  t.after(() => cleanup(ctx.root));
  withComments(ctx.gh, { 'owner/project#1': [comment(100, '历史讨论'), comment(101, '@dev')] });

  await ctx.runner.cycle();
  assert.equal(ctx.runs.length, 0, '历史 @dev 不启动 Harness');
  assert.equal(ctx.gh.created.length, 0, '历史命令不产生接单反馈');
  assert.equal(entry(ctx).seenSeq, 101);
});

test('启动后的新命令建立独立目录与会话，第二条命令续接同一会话', async (t) => {
  const ctx = setup();
  t.after(() => cleanup(ctx.root));
  const history = [comment(100, '历史讨论')];
  withComments(ctx.gh, { 'owner/project#1': history });
  await ctx.runner.cycle();
  assert.equal(ctx.runs.length, 0);

  withComments(ctx.gh, { 'owner/project#1': [...history, comment(200, '@dev')] });
  await ctx.runner.cycle();
  assert.equal(ctx.runs.length, 1);
  assert.equal(ctx.runs[0].requestedSession, null, '首轮新建会话');
  assert.equal(ctx.runs[0].cwd, entry(ctx).binding.dir, '在绑定的工作目录里启动');
  assert.equal(ctx.runs[0].capture, 'file', '缺省用文件捕获');
  assert.ok(ctx.runs[0].stdoutFile.endsWith('.stdout.log'), 'Harness 输出落本机日志');
  assert.ok(ctx.runs[0].task.includes('owner/project'), '启动消息指向目标仓库');
  assert.ok(ctx.runs[0].task.includes('Issue #1'), '启动消息指向目标 Issue');
  assert.ok(ctx.runs[0].task.includes('issuecomment-200'), '启动消息带上触发评论');
  assert.ok(ctx.runs[0].task.includes('AGENTS.md'), '启动消息要求 Dev 实际读取目标项目规则');
  assert.match(ctx.gh.created[0].body, /已接单：新建 Harness 会话/);
  assert.equal(entry(ctx).binding.sessionId, ctx.runs[0].sessionId);
  assert.equal(entry(ctx).commands[0].status, 'completed');

  withComments(ctx.gh, { 'owner/project#1': [...history, comment(200, '@dev'), comment(201, '@dev')] });
  await ctx.runner.cycle();
  assert.equal(ctx.runs.length, 2, '第二条命令再启动一次');
  assert.equal(ctx.runs[1].requestedSession, ctx.runs[0].sessionId, '续接同一会话标识');
  assert.equal(ctx.runs[1].cwd, ctx.runs[0].cwd, '仍在同一工作目录');
  assert.match(ctx.gh.created[1].body, /已接单：在该任务既有工作目录续接原 Harness 会话/);
});

test('公开回写不带任何本机路径信息，只给稳定任务标识', async (t) => {
  const ctx = setup();
  t.after(() => cleanup(ctx.root));
  await withNewCommand(ctx, comment(200, '@dev'));
  assert.equal(ctx.gh.created.length, 1);
  const body = ctx.gh.created[0].body;
  assert.ok(!body.includes(ctx.config.runtime.stateDir), '不公开状态目录');
  assert.ok(!body.includes(ctx.root), '不公开本机根路径');
  assert.ok(!body.includes('task-root'), '连目录名也不公开');
  assert.match(body, /任务标识：`ws-[0-9a-f]{8}`/);

  // 同一目录的标识稳定：下一条命令的回写用同一个值。
  const first = body.match(/任务标识：`(ws-[0-9a-f]{8})`/)[1];
  withComments(ctx.gh, { 'owner/project#1': [comment(200, '@dev'), comment(201, '@dev')] });
  await ctx.runner.cycle();
  const second = ctx.gh.created.at(-1).body.match(/任务标识：`(ws-[0-9a-f]{8})`/)[1];
  assert.equal(second, first, '同一任务目录的公开标识保持稳定');
});

test('同一份进度不重复执行：下一轮不会重放已处理命令', async (t) => {
  const ctx = setup();
  t.after(() => cleanup(ctx.root));
  const comments = [comment(100, 'x'), comment(300, '@dev')];
  withComments(ctx.gh, { 'owner/project#1': [comment(100, 'x')] });
  await ctx.runner.cycle();
  withComments(ctx.gh, { 'owner/project#1': comments });
  await ctx.runner.cycle();
  await ctx.runner.cycle();
  assert.equal(ctx.runs.length, 1, '同一命令只执行一次');
  assert.equal(entry(ctx).commands.length, 1);
});

test('恢复回退进度后，曾被回复「未启动」的命令会被正常受理而不是再回一条', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const { config } = baseConfig({ root });
  const taskDir = join(root, 'task-root');
  mkdirSync(config.runtime.stateDir, { recursive: true });
  const history = [comment(10, '历史')];
  // 状态：99 曾因「本轮已有调用」被回复过未启动，101 停在准备阶段（可重试）。恢复会把进度退到
  // 101 之前，99 因此重新进入候选——此时槽位是空的，它应当被正常受理，而不是再回一条「未启动」。
  writeFileSync(join(config.runtime.stateDir, 'state.json'), `${JSON.stringify({
    version: 1,
    repositories: {
      'owner/project': {
        1: {
          seenSeq: 101,
          binding: null,
          commands: [
            { id: 99, author: 'maintainer', status: 'busy', feedbackSent: true, at: 't0' },
            { id: 101, author: 'maintainer', status: 'claimed', at: 't1' },
          ],
        },
      },
    },
  }, null, 2)}\n`, 'utf8');

  const gh = withComments(makeGh({ issues: [issue(1, LABEL)] }), {
    'owner/project#1': [...history, comment(99, '@dev'), comment(101, '@dev')],
  });
  const { exec, runs } = makeHarnessExec();
  const logs = [];
  const runner = createRunner({ config, gh, exec, log: (m) => logs.push(m) });
  await runner.recover();
  await runner.cycle();

  const busyReplies = gh.created.filter((item) => /执行中，本条未启动/.test(item.body));
  assert.equal(busyReplies.length, 0, '不再重复回复「未启动」');
  assert.equal(runs.length, 1, '释放出来的槽位按恢复顺序受理一条');
  assert.match(gh.created.at(-1).body, /已接单：新建 Harness 会话/);
  const state = loadState(join(config.runtime.stateDir, 'state.json')).repositories['owner/project']['1'];
  assert.equal(state.commands.find((item) => item.id === 99).feedbackSent, true, '已回复标记保留');
});

test('同一轮多条新命令只执行一条，另一条明确回复未启动', async (t) => {
  const ctx = setup();
  t.after(() => cleanup(ctx.root));
  const history = [comment(100, 'x')];
  withComments(ctx.gh, { 'owner/project#1': history });
  await ctx.runner.cycle();

  withComments(ctx.gh, { 'owner/project#1': [...history, comment(400, '@dev'), comment(401, '  @dev  ')] });
  await ctx.runner.cycle();
  assert.equal(ctx.runs.length, 1, '一条命令一次调用，不叠加第二个写入者');
  assert.equal(ctx.gh.created.length, 2, '执行一条并回复另一条');
  // 「本条未启动」先发：调用可能长达 harness.timeoutMs，中途被杀会让这条回复永久丢失。
  assert.match(ctx.gh.created[0].body, /执行中，本条未启动；结束后重新发指令。/);
  assert.match(ctx.gh.created[1].body, /已接单：新建 Harness 会话/);
  assert.equal(entry(ctx).commands.find((item) => item.id === 401).status, 'busy');

  await ctx.runner.cycle();
  assert.equal(ctx.runs.length, 1, '被回复未启动的命令不重试');
});

test('被编辑过的评论不算命令', async (t) => {
  const ctx = setup();
  t.after(() => cleanup(ctx.root));
  const edited = comment(500, '@dev', 'maintainer', {
    createdAt: '2026-09-23T00:00:00Z',
    updatedAt: '2026-09-23T00:05:00Z',
  });
  await withNewCommand(ctx, edited);
  assert.equal(ctx.runs.length, 0, '编辑过的评论不启动 Harness');
  assert.equal(ctx.gh.created.length, 1);
  assert.match(ctx.gh.created[0].body, /已被编辑/);
  assert.equal(entry(ctx).seenSeq, 500, '进度仍推进，不会下轮重放');
});

test('未授权发起人的命令不启动，只回复未启动原因', async (t) => {
  const ctx = setup();
  t.after(() => cleanup(ctx.root));
  await withNewCommand(ctx, comment(500, '@dev', 'outsider'));
  assert.equal(ctx.runs.length, 0);
  assert.equal(ctx.gh.created.length, 1);
  assert.match(ctx.gh.created[0].body, /本条未启动/);
  assert.match(ctx.gh.created[0].body, /不在该仓库的 allowedActors 内/);
  assert.match(ctx.gh.created[0].body, /outsider/);
});

test('多执行机标签的 Issue 不启动，也不读评论', async (t) => {
  const ctx = setup({
    gh: {
      issues: [issue(5, 'runner:other'), issue(6, 'bug'), issue(8, LABEL, { labels: [LABEL, 'runner:mb02'] })],
    },
  });
  t.after(() => cleanup(ctx.root));
  await ctx.runner.cycle();
  await ctx.runner.cycle();

  assert.equal(ctx.gh.calls.listComments, 0, '标签不唯一的 Issue 连评论都不读');
  assert.equal(ctx.runs.length, 0, '多标签任务不启动');
  assert.ok(ctx.logs.some((line) => line.includes('执行机标签') && line.includes('runner:mb02')));
});

test('Pull Request 条目不是接单入口', async (t) => {
  const ctx = setup({ gh: { issues: [issue(9, LABEL, { fromPullRequest: true })] } });
  t.after(() => cleanup(ctx.root));
  await ctx.runner.cycle();
  assert.equal(ctx.gh.calls.listComments, 0);
  assert.equal(ctx.runs.length, 0);
  assert.ok(ctx.logs.some((line) => line.includes('这是 Pull Request')));
});

test('GitHub 读取失败不启动任务，也不伪造完成', async (t) => {
  const failure = new Error('gh api 退出码 1：rate limit exceeded');
  failure.rateLimited = true;
  const ctx = setup({ gh: { failIssues: failure } });
  t.after(() => cleanup(ctx.root));

  await ctx.runner.cycle();
  assert.equal(ctx.runs.length, 0);
  assert.equal(ctx.gh.created.length, 0);
  assert.ok(ctx.logs.some((line) => line.includes('读取 Issue 失败') && line.includes('限流')));
});

test('Harness 调用失败时如实回报失败，绑定与目录保留', async (t) => {
  const ctx = setup({ harness: { spawnThrows: new Error('spawn EPERM') } });
  t.after(() => cleanup(ctx.root));
  await withNewCommand(ctx, comment(700, '@dev'));

  assert.equal(ctx.runs.length, 0, '调用没有真正起来');
  assert.equal(ctx.gh.created.length, 2, '先接单再报失败');
  assert.match(ctx.gh.created[1].body, /接单后调用失败/);
  assert.match(ctx.gh.created[1].body, /spawn EPERM/);
  assert.equal(entry(ctx).lastRun.kind, 'failed');
  assert.equal(entry(ctx).commands[0].status, 'failed');
  assert.ok(entry(ctx).binding.dir.includes('task-root'), '工作目录保留在绑定里');
});

test('回合非零退出在 Issue 上留下可读原因，不冒充成功', async (t) => {
  const ctx = setup({
    harness: { exitCode: 1, status: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key' } } },
  });
  t.after(() => cleanup(ctx.root));
  await withNewCommand(ctx, comment(800, '@dev'));

  const record = entry(ctx);
  assert.equal(record.lastRun.kind, 'turn-failed');
  assert.equal(record.lastRun.statusKind, 'error');
  assert.equal(record.commands[0].status, 'turn-failed');
  assert.equal(ctx.gh.created.length, 2, '接单一条、回合失败一条');
  assert.match(ctx.gh.created[1].body, /回合没有正常完成/);
  assert.match(ctx.gh.created[1].body, /MISSING_CREDENTIAL|no API key/);
  assert.ok(ctx.logs.some((line) => line.includes('exit=1') && line.includes('status=error')));
});

test('回写反馈失败不导致同一次开发任务再执行', async (t) => {
  const ctx = setup();
  t.after(() => cleanup(ctx.root));
  withComments(ctx.gh, { 'owner/project#1': [comment(100, 'x')] });
  await ctx.runner.cycle();
  ctx.gh.createComment = async () => {
    throw new Error('gh api 回写失败');
  };
  withComments(ctx.gh, { 'owner/project#1': [comment(100, 'x'), comment(900, '@dev')] });
  await ctx.runner.cycle();

  assert.equal(ctx.runs.length, 1);
  assert.ok(ctx.logs.some((line) => line.includes('回写反馈失败')));
  assert.equal(entry(ctx).commands[0].status, 'completed', '反馈失败不影响调用结果记录');
});

test('绑定属于其他执行机时不启动，也不改变绑定', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const { config } = baseConfig({ root });
  const dir = join(root, 'task-root');
  mkdirSync(config.runtime.stateDir, { recursive: true });
  writeFileSync(join(config.runtime.stateDir, 'state.json'), `${JSON.stringify({
    version: 1,
    repositories: {
      'owner/project': {
        1: { seenSeq: 100, binding: { runnerId: 'mb99', dir, sessionId: 'session-x' }, commands: [] },
      },
    },
  })}\n`, 'utf8');

  const gh = withComments(makeGh({ issues: [issue(1, LABEL)] }), {
    'owner/project#1': [comment(100, 'x'), comment(1000, '@dev')],
  });
  const { exec, runs } = makeHarnessExec();
  const runner = createRunner({ config, gh, exec, log: () => {} });
  await runner.cycle();

  assert.equal(runs.length, 0);
  assert.equal(gh.created.length, 1);
  assert.match(gh.created[0].body, /本条未启动/);
  assert.match(gh.created[0].body, /绑定属于执行机 mb99/);
  const state = loadState(join(config.runtime.stateDir, 'state.json')).repositories['owner/project']['1'];
  assert.equal(state.binding.runnerId, 'mb99', '不覆盖原有绑定');
});

test('绑定的工作目录丢失时报告，不静默新建会话', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const { config } = baseConfig({ root });
  const gone = join(root, 'removed-dir');
  mkdirSync(config.runtime.stateDir, { recursive: true });
  writeFileSync(join(config.runtime.stateDir, 'state.json'), `${JSON.stringify({
    version: 1,
    repositories: {
      'owner/project': {
        1: { seenSeq: 100, binding: { runnerId: 'mb01', dir: gone, sessionId: 'session-a' }, commands: [] },
      },
    },
  })}\n`, 'utf8');

  const gh = withComments(makeGh({ issues: [issue(1, LABEL)] }), {
    'owner/project#1': [comment(100, 'x'), comment(1100, '@dev')],
  });
  const { exec, runs } = makeHarnessExec();
  const runner = createRunner({ config, gh, exec, log: () => {} });
  await runner.cycle();

  assert.equal(runs.length, 0, '目录不符时不启动');
  assert.equal(gh.created.length, 1);
  assert.match(gh.created[0].body, /工作目录已不存在/);
});

test('旧版本状态：被当成基线吞掉的命令在恢复后重新受理一次', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const { config } = baseConfig({ root });
  const taskDir = join(root, 'task-root');
  mkdirSync(config.runtime.stateDir, { recursive: true });
  // 旧版本语义：空 Issue 的基线是 0，首条命令被当成基线登记后就成了 seenSeq=0 + claimed 的卡住状态。
  writeFileSync(join(config.runtime.stateDir, 'state.json'), `${JSON.stringify({
    version: 1,
    repositories: {
      'owner/project': {
        1: {
          seenSeq: 0,
          binding: { runnerId: 'mb01', dir: taskDir, sessionId: null },
          commands: [{ id: 100, author: 'maintainer', status: 'claimed', at: 't0' }],
        },
      },
    },
  }, null, 2)}\n`, 'utf8');

  const gh = withComments(makeGh({ issues: [issue(1, LABEL)] }), {
    'owner/project#1': [comment(100, '@dev')],
  });
  const { exec, runs } = makeHarnessExec();
  const logs = [];
  const runner = createRunner({ config, gh, exec, log: (m) => logs.push(m) });
  await runner.recover();
  await runner.cycle();
  assert.equal(runs.length, 1, '被吞掉的命令重新受理一次');
  assert.ok(logs.some((line) => line.includes('状态来自旧版本')), '记录迁移动作');
  const state = loadState(join(config.runtime.stateDir, 'state.json')).repositories['owner/project']['1'];
  assert.equal(state.commands[0].status, 'completed', '重试后进入正常终态');
});

test('重启恢复：已认领未结束的命令报结果不确定并保持绑定', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const { config } = baseConfig({ root });
  const dir = join(root, 'task-root');
  mkdirSync(config.runtime.stateDir, { recursive: true });
  writeFileSync(join(config.runtime.stateDir, 'state.json'), `${JSON.stringify({
    version: 1,
    repositories: {
      'owner/project': {
        1: {
          seenSeq: 800,
          inFlight: true,
          binding: { runnerId: 'mb01', dir, sessionId: 'session-existing' },
          commands: [{ id: 800, author: 'maintainer', status: 'claimed', at: 't0' }],
        },
      },
    },
  }, null, 2)}\n`, 'utf8');

  const gh = makeGh({ issues: [issue(1, LABEL)] });
  const { exec, runs } = makeHarnessExec();
  const runner = createRunner({ config, gh, exec, log: () => {} });
  await runner.recover();
  assert.equal(gh.created.length, 1);
  assert.match(gh.created[0].body, /结果不确定/);
  assert.equal(runs.length, 0, '恢复不自动重跑');
  const state = loadState(join(config.runtime.stateDir, 'state.json')).repositories['owner/project']['1'];
  assert.equal(state.commands[0].status, 'uncertain');
  assert.equal(state.commands[0].retryable, false, '已有绑定：不重跑同一条命令');
  assert.equal(state.inFlight, false, '残留的执行中标记被清掉，下一次命令不会被当成忙碌');
  assert.equal(state.binding.sessionId, 'session-existing', '绑定保留，供下一条命令续接');

  // 恢复后下一条新命令按原绑定与原目录续接，不被残留标记挡住。
  const gh2 = withComments(makeGh({ issues: [issue(1, LABEL)] }), {
    'owner/project#1': [comment(800, '@dev'), comment(801, '@dev')],
  });
  const runner2 = createRunner({ config, gh: gh2, exec, log: () => {} });
  await runner2.cycle();
  assert.equal(runs.length, 1, '恢复后新命令可以继续执行');
  assert.equal(runs[0].requestedSession, 'session-existing', '续接原会话');
  assert.equal(runs[0].cwd, dir, '仍在原工作目录');
  assert.equal(gh2.created.length, 1, '已报不确定的旧命令不重复回复');
});

test('重启恢复：上次停在准备阶段的命令会被重试一次，不被永久跳过', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const { config } = baseConfig({ root });
  mkdirSync(config.runtime.stateDir, { recursive: true });
  writeFileSync(join(config.runtime.stateDir, 'state.json'), `${JSON.stringify({
    version: 1,
    repositories: {
      'owner/project': {
        1: {
          seenSeq: 800,
          inFlight: true,
          binding: null,
          commands: [{ id: 800, author: 'maintainer', status: 'claimed', at: 't0' }],
        },
      },
    },
  }, null, 2)}\n`, 'utf8');

  const gh = makeGh({ issues: [issue(1, LABEL)] });
  const { exec, runs } = makeHarnessExec();
  const runner = createRunner({ config, gh, exec, log: () => {} });
  await runner.recover();
  assert.equal(runs.length, 0, '恢复本身不调用 Harness');
  assert.equal(gh.created.length, 1, '回报结果不确定');
  assert.match(gh.created[0].body, /会在下一轮检查时重试一次/);

  // 下一轮：同一条评论仍然满足条件，应当被重试一次。
  const gh2 = withComments(makeGh({ issues: [issue(1, LABEL)] }), {
    'owner/project#1': [comment(800, '@dev')],
  });
  const runner2 = createRunner({ config, gh: gh2, exec, log: () => {} });
  await runner2.cycle();
  assert.equal(runs.length, 1, '同一条命令重试一次');
  assert.equal(gh2.created.length, 1, '重试后回写正常接单');

  // 再一轮不应重复：重试成功后该命令状态不再是 claimed。
  await runner2.cycle();
  assert.equal(runs.length, 1, '重试只发生一次');
});

test('状态文件损坏时明确失败，不覆盖原文件', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const { config } = baseConfig({ root });
  mkdirSync(config.runtime.stateDir, { recursive: true });
  const stateFile = join(config.runtime.stateDir, 'state.json');
  writeFileSync(stateFile, '{ 这不是 JSON', 'utf8');

  const { exec } = makeHarnessExec();
  assert.throws(() => createRunner({ config, gh: makeGh(), exec, log: () => {} }), /状态文件不是合法 JSON/);
  assert.equal(readFileSync(stateFile, 'utf8'), '{ 这不是 JSON', '不覆盖无法解读的状态文件');
});

test('不同仓库的同号 Issue 各自绑定，不混淆', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  // repoDir 是「部署者已备好的任务根目录」，必须预先存在。
  for (const name of ['one', 'two']) mkdirSync(join(root, name), { recursive: true });
  const { config } = baseConfig({
    root,
    overrides: {
      repositories: [
        { repo: 'owner/one', allowedActors: ['maintainer'], repoDir: join(root, 'one') },
        { repo: 'owner/two', allowedActors: ['maintainer'], repoDir: join(root, 'two') },
      ],
    },
  });
  const gh = makeGh({ issues: [issue(1, LABEL)] });
  gh.listComments = async () => [comment(100, 'x')];
  const { exec, runs } = makeHarnessExec();
  const runner = createRunner({ config, gh, exec, log: () => {} });
  await runner.cycle();

  gh.listComments = async ({ repo }) => (repo === 'owner/one'
    ? [comment(100, 'x'), comment(200, '@dev')]
    : [comment(100, 'x'), comment(300, '@dev')]);
  await runner.cycle();

  assert.equal(runs.length, 2, '两个仓库各自启动一次');
  assert.notEqual(runs[0].cwd, runs[1].cwd, '不同仓库使用不同工作目录');
  const state = loadState(join(config.runtime.stateDir, 'state.json'));
  assert.equal(state.repositories['owner/one']['1'].binding.dir, join(root, 'one'));
  assert.equal(state.repositories['owner/two']['1'].binding.dir, join(root, 'two'));
  assert.equal(state.repositories['owner/one']['1'].seenSeq, 200);
  assert.equal(state.repositories['owner/two']['1'].seenSeq, 300);
});
