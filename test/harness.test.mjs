import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { HarnessError, readResult, runHarness } from '../src/harness.mjs';
import { cleanup, makeTempDir } from './helpers.mjs';

const HARNESS = {
  bin: 'C:/dsh/lib/bin.js',
  profile: 'headless',
  patch: 'C:/repo/scripts/headless-session/overlay.yml',
  node: 'C:/node/node.exe',
  home: 'C:/dsh-home',
  timeoutMs: 1234,
};

test('调用命令是「启动器 + headless profile + overlay」，任务与结果走环境变量', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const calls = [];
  const exec = async (options) => {
    calls.push(options);
    writeFileSync(options.stdoutFile, '{"sessionId":"session-1"}\n', 'utf8');
    writeFileSync(options.stderrFile, 'dsh: reasoning:\n', 'utf8');
    writeFileSync(options.env.DSH_RESULT_FILE, `${JSON.stringify({
      sessionId: 'session-1',
      continueReason: 'created',
      status: { kind: 'completed' },
      text: '好的',
      cwd: options.cwd,
    })}\n`, 'utf8');
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const outcome = await runHarness({
    harness: HARNESS,
    exec,
    cwd: root,
    task: '任务文本',
    sessionId: null,
    resultPath: join(root, 'result.json'),
    stdoutPath: join(root, 'out.log'),
    stderrPath: join(root, 'err.log'),
  });

  assert.equal(calls[0].command, HARNESS.node);
  assert.deepEqual(calls[0].args, [HARNESS.bin, '--profile', 'headless', '--patch', HARNESS.patch]);
  assert.equal(calls[0].cwd, root);
  assert.equal(calls[0].timeoutMs, 1234);
  assert.equal(calls[0].env.DSH_TASK, '任务文本');
  assert.equal(calls[0].env.DSH_HOME, 'C:/dsh-home');
  assert.equal(calls[0].env.DSH_BIN, HARNESS.bin, '本地 runner 按 DSH_BIN 解析随安装提供的包');
  assert.equal(calls[0].env.DSH_SESSION_ID, undefined, '首轮不给会话标识');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.sessionId, 'session-1');
  assert.equal(outcome.statusKind, 'completed');
  assert.equal(outcome.continueReason, 'created');
});

test('续接时把已保存的会话标识交给 CLI', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  let seen;
  const exec = async (options) => {
    seen = options.env.DSH_SESSION_ID;
    writeFileSync(options.env.DSH_RESULT_FILE, `${JSON.stringify({
      sessionId: 'session-1',
      continueReason: 'resumed',
      status: { kind: 'completed' },
      text: '',
      cwd: options.cwd,
    })}\n`, 'utf8');
    return { exitCode: 0, stdout: '', stderr: '' };
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
  assert.equal(seen, 'session-1');
  assert.equal(outcome.continueReason, 'resumed');
});

test('结果判读区分完成、回合错误、非零退出与不可判读', () => {
  const root = makeTempDir();
  try {
    const resultPath = join(root, 'result.json');
    assert.equal(readResult({ resultPath, exitCode: 1, stdout: '', stderr: '' }).statusKind, null, '缺结果文件不冒充完成');

    writeFileSync(resultPath, `${JSON.stringify({ sessionId: 's', status: { kind: 'aborted' } })}\n`, 'utf8');
    const aborted = readResult({ resultPath, exitCode: 1, stdout: '', stderr: '' });
    assert.equal(aborted.statusKind, 'aborted');
    assert.equal(aborted.exitCode, 1);

    writeFileSync(resultPath, `${JSON.stringify({
      sessionId: 's',
      status: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key' } },
    })}\n`, 'utf8');
    const failed = readResult({ resultPath, exitCode: 1, stdout: '', stderr: 'dsh: MISSING_CREDENTIAL: no API key' });
    assert.equal(failed.statusKind, 'error');
    assert.equal(failed.errorCode, 'MISSING_CREDENTIAL');
    assert.match(failed.detail, /no API key/);

    writeFileSync(resultPath, '{ 坏 JSON', 'utf8');
    const broken = readResult({ resultPath, exitCode: 0, stdout: '{"sessionId":"x"}\n', stderr: '' });
    assert.match(broken.detail, /结果文件不是合法 JSON/);
    assert.equal(broken.sessionId, null);

    writeFileSync(resultPath, '\n', 'utf8');
    const empty = readResult({ resultPath, exitCode: 1, stdout: '', stderr: 'error: a task is required' });
    assert.match(empty.detail, /结果文件不是合法 JSON/, '结果文件存在但读不出结构时按不可判读处理');

    const missing = readResult({
      resultPath: join(root, 'never-written.json'),
      exitCode: 1,
      stdout: '',
      stderr: 'error: a task is required',
    });
    assert.match(missing.detail, /a task is required/, '没有结果文件时用 stderr 作为失败摘要');
    assert.equal(missing.statusKind, null);
  } finally {
    cleanup(root);
  }
});

test('子进程无法启动属于调用失败，与回合失败分开表述', async () => {
  const exec = async () => {
    throw new Error('node 无法启动：spawn ENOENT');
  };
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

test('缺 DSH_BIN 的用法错误不会被当成成功', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const exec = async (options) => {
    const resultPath = options.env.DSH_RESULT_FILE;
    mkdirSync(root, { recursive: true });
    writeFileSync(resultPath, `${JSON.stringify({
      sessionId: '',
      status: { kind: 'error', error: { code: 'USAGE', message: 'DSH_TASK is required' } },
    })}\n`, 'utf8');
    return { exitCode: 1, stdout: '', stderr: 'dsh: DSH_TASK is required\n' };
  };
  const outcome = await runHarness({
    harness: HARNESS,
    exec,
    cwd: root,
    task: 'x',
    sessionId: null,
    resultPath: join(root, 'result.json'),
    stdoutPath: join(root, 'out.log'),
    stderrPath: join(root, 'err.log'),
  });
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.statusKind, 'error');
  assert.equal(outcome.sessionId, null);
});
