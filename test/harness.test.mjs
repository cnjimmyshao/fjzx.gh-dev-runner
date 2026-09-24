import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { HarnessError, readResult, runHarness } from '../src/harness.mjs';
import { cleanup, makeTempDir } from './helpers.mjs';

const HARNESS = {
  bin: 'C:/dsh/lib/bin.js',
  profile: 'headless',
  node: 'C:/node/node.exe',
  home: 'C:/dsh-home',
  timeoutMs: 1234,
};

function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

test('首轮直接调用官方 headless --json，任务正文走 stdin', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const calls = [];
  const exec = async (options) => {
    calls.push(options);
    return {
      exitCode: 0,
      stdout: jsonl([
        { type: 'session', sessionId: 'session-1', cwd: options.cwd },
        { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
        { type: 'final', text: '好的' },
      ]),
      stderr: '',
    };
  };

  const resultPath = join(root, 'result.json');
  const outcome = await runHarness({
    harness: HARNESS,
    exec,
    cwd: root,
    task: '任务文本',
    sessionId: null,
    resultPath,
    stdoutPath: join(root, 'out.log'),
    stderrPath: join(root, 'err.log'),
  });

  assert.equal(calls[0].command, HARNESS.node);
  assert.deepEqual(calls[0].args, [HARNESS.bin, '--profile', 'headless', '--json']);
  assert.equal(calls[0].stdin, '任务文本');
  assert.equal(calls[0].cwd, root);
  assert.equal(calls[0].env.DSH_HOME, 'C:/dsh-home');
  assert.equal(calls[0].env.DSH_TASK, undefined);
  assert.equal(calls[0].env.DSH_SESSION_ID, undefined);
  assert.equal(calls[0].env.DSH_RESULT_FILE, undefined);
  assert.equal(calls[0].env.DSH_BIN, undefined);
  assert.equal(outcome.sessionId, 'session-1');
  assert.equal(outcome.statusKind, 'completed');
  assert.equal(outcome.continueReason, 'created');
  assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).sessionId, 'session-1');
});

test('续接时只通过官方 --session-id 交回原会话标识', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  let call;
  const exec = async (options) => {
    call = options;
    return {
      exitCode: 0,
      stdout: jsonl([
        { type: 'session', sessionId: 'session-1', cwd: options.cwd },
        { type: 'status', phase: 'turn_end', turn: 2, reason: { kind: 'completed' } },
        { type: 'final', text: '' },
      ]),
      stderr: '',
    };
  };
  const outcome = await runHarness({
    harness: HARNESS,
    exec,
    cwd: root,
    task: '继续',
    sessionId: 'session-1',
    resultPath: join(root, 'result.json'),
    stdoutPath: join(root, 'out.log'),
    stderrPath: join(root, 'err.log'),
  });
  assert.deepEqual(call.args, [
    HARNESS.bin, '--profile', 'headless', '--json', '--session-id', 'session-1',
  ]);
  assert.equal(call.stdin, '继续');
  assert.ok(!call.args.includes('--patch'));
  assert.equal(outcome.sessionId, 'session-1');
  assert.equal(outcome.continueReason, 'resumed');
});

test('JSONL 判读：正常、回合错误与 direct-driver error 分开', () => {
  const completed = readResult({
    exitCode: 0,
    stdout: jsonl([
      { type: 'session', sessionId: 's', cwd: '/x' },
      { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
      { type: 'final', text: 'done' },
    ]),
    stderr: '',
  });
  assert.equal(completed.statusKind, 'completed');

  const turnError = readResult({
    exitCode: 1,
    stdout: jsonl([
      { type: 'session', sessionId: 's', cwd: '/x' },
      {
        type: 'status',
        phase: 'turn_end',
        reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key' } },
      },
      { type: 'final', text: '' },
    ]),
    stderr: 'dsh: MISSING_CREDENTIAL: no API key\n',
  });
  assert.equal(turnError.statusKind, 'error');
  assert.equal(turnError.errorCode, 'MISSING_CREDENTIAL');
  assert.match(turnError.reason, /MISSING_CREDENTIAL/);

  const directError = readResult({
    exitCode: 1,
    stdout: jsonl([{ type: 'error', message: 'session "missing" does not exist' }]),
    stderr: 'dsh: session "missing" does not exist\n',
    requestedSessionId: 'missing',
  });
  assert.equal(directError.statusKind, 'error');
  assert.equal(directError.sessionId, null);
  assert.match(directError.detail, /does not exist/);
});

test('损坏 JSONL 不冒充完成，但已取得的 sessionId 必须保留', () => {
  const outcome = readResult({
    exitCode: 0,
    stdout: [
      JSON.stringify({ type: 'session', sessionId: 'session-new', cwd: '/x' }),
      '{ bad json',
      JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }),
      JSON.stringify({ type: 'final', text: 'done' }),
      '',
    ].join('\n'),
    stderr: '',
  });
  assert.equal(outcome.sessionId, 'session-new', '不能因后续解析失败丢掉真实会话身份');
  assert.equal(outcome.statusKind, null, '流不完整时不能冒充 completed');
  assert.match(outcome.detail, /不是合法 JSON/);
});

test('续接返回不同 sessionId 时拒绝把它当成正常完成', () => {
  const outcome = readResult({
    exitCode: 0,
    stdout: jsonl([
      { type: 'session', sessionId: 'other', cwd: '/x' },
      { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
      { type: 'final', text: 'done' },
    ]),
    stderr: '',
    requestedSessionId: 'expected',
  });
  assert.equal(outcome.statusKind, null);
  assert.match(outcome.reason, /sessionId 与请求不一致/);
});

test('公开 reason 不泄露 text/thinking/tool 输出', () => {
  const outcome = readResult({
    exitCode: 1,
    stdout: jsonl([
      { type: 'session', sessionId: 's', cwd: '/x' },
      { type: 'thinking', text: 'TOP-SECRET-THOUGHT' },
      { type: 'text', text: 'TOP-SECRET-ANSWER' },
      { type: 'tool_result', callId: 'c1', status: 'error', result: 'TOP-SECRET-TOOL' },
      { type: 'status', phase: 'turn_end', reason: { kind: 'aborted' } },
      { type: 'final', text: 'TOP-SECRET-FINAL' },
    ]),
    stderr: '',
  });
  assert.equal(outcome.statusKind, 'aborted');
  for (const secret of ['THOUGHT', 'ANSWER', 'TOOL', 'FINAL']) {
    assert.ok(!outcome.reason.includes(secret), `公开 reason 泄露 ${secret}`);
  }
});

test('退出 0 但缺关键控制事件时按不可判读处理', () => {
  for (const stdout of [
    jsonl([{ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }, { type: 'final', text: '' }]),
    jsonl([{ type: 'session', sessionId: 's' }, { type: 'final', text: '' }]),
    jsonl([{ type: 'session', sessionId: 's' }, { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }]),
  ]) {
    assert.equal(readResult({ exitCode: 0, stdout, stderr: '' }).statusKind, null);
  }
});

test('子进程无法启动属于调用失败', async () => {
  const exec = async () => { throw new Error('node 无法启动：spawn ENOENT'); };
  await assert.rejects(
    () => runHarness({
      harness: HARNESS,
      exec,
      cwd: process.cwd(),
      task: 'x',
      sessionId: null,
      resultPath: 'r.json',
      stdoutPath: 'o.log',
      stderrPath: 'e.log',
    }),
    (error) => {
      assert.ok(error instanceof HarnessError);
      assert.match(error.message, /Harness 调用失败/);
      return true;
    },
  );
});

test('派生摘要写入失败不丢失已运行会话的 sessionId', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const outcome = await runHarness({
    harness: HARNESS,
    exec: async () => ({
      exitCode: 0,
      stdout: jsonl([
        { type: 'session', sessionId: 'session-safe' },
        { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
        { type: 'final', text: 'done' },
      ]),
      stderr: '',
    }),
    cwd: root,
    task: 'x',
    sessionId: null,
    resultPath: join(root, 'missing-parent', 'result.json'),
    stdoutPath: join(root, 'out.log'),
    stderrPath: join(root, 'err.log'),
  });
  assert.equal(outcome.sessionId, 'session-safe');
  assert.match(outcome.detail, /结果文件写入失败/);
  assert.equal(existsSync(join(root, 'missing-parent', 'result.json')), false);
});
