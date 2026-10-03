import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  HARNESS_FAILURE,
  buildHarnessEnv,
  classifyHarnessResult,
  createFileTail,
  createHarnessRunner,
  createLineReader,
  harnessInvocation,
} from '../src/harness.js';
import { buildTaskMessage } from '../src/prompt.js';
import { cleanup, makeConfig, tempDir } from './helpers.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * 写一个按模式行为的假 Harness：只使用 Node 内置能力，接收 stdin 任务并输出 `--json` 事件流。
 * @param {string} dir
 * @param {string} mode
 */
function writeFakeHarness(dir, mode) {
  const file = path.join(dir, `fake-${mode}.mjs`);
  const taskFile = path.join(dir, `${mode}-task.txt`);
  fs.writeFileSync(
    file,
    `import fs from 'node:fs';
const args = process.argv.slice(2);
const sessionArgIndex = args.indexOf('--session-id');
const requested = sessionArgIndex >= 0 ? args[sessionArgIndex + 1] : null;
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
fs.writeFileSync(${JSON.stringify(taskFile)}, Buffer.concat(chunks).toString('utf8'));
const mode = ${JSON.stringify(mode)};
if (mode === 'busy') {
  emit({ type: 'error', message: 'session "x" is already owned by an active write handle' });
  process.exit(1);
}
if (mode === 'refused') {
  emit({ type: 'error', message: 'dsh: session "x" was recorded in "/other", not "/here"' });
  process.exit(1);
}
if (mode === 'silent-ok') process.exit(0);
if (mode === 'split-utf8') {
  emit({ type: 'session', sessionId: 'session-utf8', cwd: process.cwd() });
  const payload = Buffer.from(JSON.stringify({ type: 'text', text: '中文内容' }) + '\\n', 'utf8');
  const cut = payload.indexOf(Buffer.from('中', 'utf8')) + 1;
  process.stdout.write(payload.subarray(0, cut));
  await new Promise((resolve) => setTimeout(resolve, 400));
  process.stdout.write(payload.subarray(cut));
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  process.exit(0);
}
if (mode === 'slow') {
  emit({ type: 'session', sessionId: 'session-slow', cwd: process.cwd() });
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  process.exit(0);
}
emit({ type: 'session', sessionId: mode === 'mismatch' ? 'session-other' : (requested ?? 'session-fake'), cwd: process.cwd() });
emit({ type: 'status', phase: 'turn_start', turn: 1 });
emit({ type: 'thinking', text: 'THINKING-TEXT' });
emit({ type: 'text', text: 'ANSWER-TEXT' });
process.stdout.write('{"type":"broken"\\n');
emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: mode === 'failed-round' ? 'error' : 'completed' } });
emit({ type: 'final', text: 'ANSWER-TEXT' });
process.exit(mode === 'failed-round' ? 1 : 0);
`,
    { mode: 0o700 },
  );
  return { file, taskFile };
}

function makeHarnessConfig(overrides = {}) {
  const dir = tempDir('fjzx-harness-');
  const config = makeConfig({
    stateDir: dir,
    harness: { bin: path.join(dir, 'fake-ok.mjs'), profile: 'headless', home: null, timeoutMs: 0, envAllowlist: [] },
    ...overrides,
  });
  return { dir, config };
}

test('createLineReader 不在半行上触发回调', () => {
  const lines = [];
  const reader = createLineReader((line) => lines.push(line));
  reader.push('{"a":');
  assert.deepEqual(lines, []);
  reader.push('1}\n{"b":2}\n{"c"');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  reader.flush();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c"']);
});

test('buildHarnessEnv 只给最小系统环境 + DSH_HOME + allowlist', () => {
  const { dir, config } = makeHarnessConfig();
  try {
    config.harness.home = '/tmp/dsh-home';
    config.harness.envAllowlist = ['DSH_MODEL_KEY'];
    const env = buildHarnessEnv(config, {
      PATH: '/usr/bin',
      HOME: '/Users/someone',
      LANG: 'en_US.UTF-8',
      DSH_MODEL_KEY: 'secret-value',
      GH_TOKEN: 'should-not-pass',
      RANDOM_VAR: 'nope',
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/Users/someone');
    assert.equal(env.DSH_HOME, '/tmp/dsh-home');
    assert.equal(env.DSH_MODEL_KEY, 'secret-value');
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.RANDOM_VAR, undefined);
  } finally {
    cleanup(dir);
  }
});

test('harnessInvocation 对 .js 入口用当前 Node 运行，并区分 START / RESUME', () => {
  const { dir, config } = makeHarnessConfig();
  try {
    const start = harnessInvocation(config, null);
    assert.equal(start.command, process.execPath);
    assert.deepEqual(start.args, [config.harness.bin, '--profile', 'headless', '--json']);

    const resume = harnessInvocation(config, 'session-1');
    assert.deepEqual(resume.args.slice(-2), ['--session-id', 'session-1']);

    const direct = harnessInvocation({ harness: { bin: '/usr/local/bin/dsh', profile: 'headless' } }, null);
    assert.equal(direct.command, '/usr/local/bin/dsh');
  } finally {
    cleanup(dir);
  }
});

test('START / RESUME 成功：生成的任务经 stdin 完整送达，续接保留 session 与目录', async () => {
  const { dir, config } = makeHarnessConfig();
  try {
    const fake = writeFakeHarness(dir, 'ok');
    config.harness.bin = fake.file;
    const runner = createHarnessRunner({ config, logger: silent });
    const workdir = path.join(dir, 'work');
    fs.mkdirSync(workdir);
    const coordinates = {
      repository: 'owner/repo',
      issueNumber: 83,
      sourceType: 'comment',
      sourceId: '12345',
      requester: 'alice',
    };
    const startTask = buildTaskMessage({ ...coordinates, kind: 'start' });
    const handle = runner.launch({
      runId: 'run-1',
      kind: 'start',
      dir: workdir,
      sessionId: null,
      task: startTask,
    });

    assert.equal(await handle.sessionId, 'session-fake');
    assert.equal(await handle.earlySignal, true);
    const result = await handle.exited;
    assert.equal(result.exitCode, 0);
    assert.equal(result.turnEndReason, 'completed');
    assert.equal(result.hadAssistantCommit, true);
    assert.equal(result.invalidLines, 1, '半截/坏行不会中断解析');
    assert.deepEqual(classifyHarnessResult(result), { ok: true, category: null });
    assert.equal(fs.readFileSync(fake.taskFile, 'utf8'), startTask);

    // capture=metadata：只保留技术事件，模型正文不长期落盘
    runner.finalizeCapture(handle.record === null ? '' : path.join(config.runtime.stateDir, 'runs', 'run-1'));
    const capture = fs.readFileSync(path.join(config.runtime.stateDir, 'runs', 'run-1', 'stdout.jsonl'), 'utf8');
    assert.match(capture, /"type":"session"/);
    assert.match(capture, /"phase":"turn_end"/);
    assert.doesNotMatch(capture, /ANSWER-TEXT|THINKING-TEXT/);
    assert.equal(
      fs.existsSync(path.join(config.runtime.stateDir, 'runs', 'run-1', 'stderr.log')),
      false,
      'metadata 模式不长期保留 stderr 捕获',
    );

    const resumeTask = buildTaskMessage({ ...coordinates, kind: 'resume', sourceId: '12346' });
    const resumed = runner.launch({
      runId: 'run-1-resume',
      kind: 'resume',
      dir: workdir,
      sessionId: await handle.sessionId,
      task: resumeTask,
    });
    assert.equal(await resumed.sessionId, await handle.sessionId);
    assert.equal(await resumed.earlySignal, true);
    const resumedResult = await resumed.exited;
    assert.deepEqual(classifyHarnessResult(resumedResult), { ok: true, category: null });
    assert.equal(fs.readFileSync(fake.taskFile, 'utf8'), resumeTask);
    const resumedCapture = fs.readFileSync(path.join(config.runtime.stateDir, 'runs', 'run-1-resume', 'stdout.jsonl'), 'utf8');
    const sessionEvent = resumedCapture.trim().split('\n').map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((event) => event?.type === 'session');
    assert.ok(sessionEvent, '续接返回 session 事件');
    assert.equal(fs.realpathSync(sessionEvent.cwd), fs.realpathSync(workdir), '子进程继续使用原任务目录');
  } finally {
    cleanup(dir);
  }
});

test('capture=full 时保留完整事件流与 stderr 文件', async () => {
  const { dir, config } = makeHarnessConfig({ runtime: { capture: 'full' } });
  try {
    const fake = writeFakeHarness(dir, 'ok');
    config.harness.bin = fake.file;
    const runner = createHarnessRunner({ config, logger: silent });
    const workdir = path.join(dir, 'work');
    fs.mkdirSync(workdir);
    const handle = runner.launch({ runId: 'run-full', kind: 'start', dir: workdir, sessionId: null, task: 'x' });
    await handle.exited;
    runner.finalizeCapture(path.join(config.runtime.stateDir, 'runs', 'run-full'));
    const capture = fs.readFileSync(path.join(config.runtime.stateDir, 'runs', 'run-full', 'stdout.jsonl'), 'utf8');
    assert.match(capture, /ANSWER-TEXT/);
    assert.ok(fs.existsSync(path.join(config.runtime.stateDir, 'runs', 'run-full', 'stderr.log')));
  } finally {
    cleanup(dir);
  }
});

test('createFileTail 保留被切断的多字节字符', () => {
  const dir = tempDir('fjzx-tail-');
  try {
    const file = path.join(dir, 'stream.jsonl');
    const payload = Buffer.from(`${JSON.stringify({ type: 'text', text: '中文内容' })}\n`, 'utf8');
    const cut = payload.indexOf(Buffer.from('中', 'utf8')) + 1;
    fs.writeFileSync(file, payload.subarray(0, cut));
    const tail = createFileTail(file);
    const first = tail.read();
    assert.equal(first.includes('\uFFFD'), false, '不完整字符不得立即解码成替换字符');
    fs.appendFileSync(file, payload.subarray(cut));
    const text = `${first}${tail.read()}${tail.flush()}`;
    assert.deepEqual(JSON.parse(text.trim()), { type: 'text', text: '中文内容' });
  } finally {
    cleanup(dir);
  }
});

test('分批写入的事件流仍能被完整判读', async () => {
  const { dir, config } = makeHarnessConfig();
  try {
    const fake = writeFakeHarness(dir, 'split-utf8');
    config.harness.bin = fake.file;
    const runner = createHarnessRunner({ config, logger: silent, tailIntervalMs: 20 });
    const workdir = path.join(dir, 'work');
    fs.mkdirSync(workdir);
    const handle = runner.launch({ runId: 'run-utf8', kind: 'start', dir: workdir, sessionId: null, task: 'x' });
    const result = await handle.exited;
    assert.equal(result.invalidLines, 0, '不应产生无法解析的半截行');
    assert.equal(result.hadAssistantCommit, true);
    assert.equal(result.sessionId, 'session-utf8');
    assert.deepEqual(classifyHarnessResult(result), { ok: true, category: null });
  } finally {
    cleanup(dir);
  }
});

test('同 session 第二写入者被拒绝：判为未启动 / 未写入', async () => {
  const { dir, config } = makeHarnessConfig();
  try {
    const fake = writeFakeHarness(dir, 'busy');
    config.harness.bin = fake.file;
    const runner = createHarnessRunner({ config, logger: silent });
    const workdir = path.join(dir, 'work');
    fs.mkdirSync(workdir);
    const handle = runner.launch({ runId: 'run-busy', kind: 'resume', dir: workdir, sessionId: 'session-x', task: 'x' });
    const result = await handle.exited;
    assert.equal(result.exitCode, 1);
    assert.equal(result.sessionId, null);
    assert.deepEqual(classifyHarnessResult(result), { ok: false, category: HARNESS_FAILURE.sessionBusy });
  } finally {
    cleanup(dir);
  }
});

test('未知会话 / cwd 不匹配被拒绝时判为无法续接', async () => {
  const { dir, config } = makeHarnessConfig();
  try {
    const fake = writeFakeHarness(dir, 'refused');
    config.harness.bin = fake.file;
    const runner = createHarnessRunner({ config, logger: silent });
    const workdir = path.join(dir, 'work');
    fs.mkdirSync(workdir);
    const handle = runner.launch({ runId: 'run-refused', kind: 'resume', dir: workdir, sessionId: 'session-x', task: 'x' });
    const result = await handle.exited;
    assert.deepEqual(classifyHarnessResult(result), { ok: false, category: HARNESS_FAILURE.sessionRefused });
  } finally {
    cleanup(dir);
  }
});

test('续接返回不同 sessionId 时判为绑定不一致', async () => {
  const { dir, config } = makeHarnessConfig();
  try {
    const fake = writeFakeHarness(dir, 'mismatch');
    config.harness.bin = fake.file;
    const runner = createHarnessRunner({ config, logger: silent });
    const workdir = path.join(dir, 'work');
    fs.mkdirSync(workdir);
    const handle = runner.launch({
      runId: 'run-mismatch',
      kind: 'resume',
      dir: workdir,
      sessionId: 'session-wanted',
      task: 'x',
    });
    const result = await handle.exited;
    assert.equal(result.sessionMismatch, true);
    assert.deepEqual(classifyHarnessResult(result), { ok: false, category: HARNESS_FAILURE.sessionMismatch });
  } finally {
    cleanup(dir);
  }
});

test('退出码 0 但没有轮次结束事件时不冒充完成', async () => {
  const { dir, config } = makeHarnessConfig();
  try {
    const fake = writeFakeHarness(dir, 'silent-ok');
    config.harness.bin = fake.file;
    const runner = createHarnessRunner({ config, logger: silent });
    const workdir = path.join(dir, 'work');
    fs.mkdirSync(workdir);
    const handle = runner.launch({ runId: 'run-silent', kind: 'start', dir: workdir, sessionId: null, task: 'x' });
    const result = await handle.exited;
    assert.equal(result.exitCode, 0);
    assert.deepEqual(classifyHarnessResult(result), { ok: false, category: HARNESS_FAILURE.roundFailed });
  } finally {
    cleanup(dir);
  }
});

test('轮次内失败（turn_end reason=error）不被当成正常完成', async () => {
  const { dir, config } = makeHarnessConfig();
  try {
    const fake = writeFakeHarness(dir, 'failed-round');
    config.harness.bin = fake.file;
    const runner = createHarnessRunner({ config, logger: silent });
    const workdir = path.join(dir, 'work');
    fs.mkdirSync(workdir);
    const handle = runner.launch({ runId: 'run-failed', kind: 'start', dir: workdir, sessionId: null, task: 'x' });
    const result = await handle.exited;
    assert.equal(result.exitCode, 1);
    assert.equal(result.turnEndReason, 'error');
    assert.deepEqual(classifyHarnessResult(result), { ok: false, category: HARNESS_FAILURE.harnessError });
  } finally {
    cleanup(dir);
  }
});

test('超时会被判为 timeout，并且已经取得的 sessionId 不丢失', async () => {
  const { dir, config } = makeHarnessConfig({ harness: { timeoutMs: 400 } });
  try {
    const fake = writeFakeHarness(dir, 'slow');
    config.harness.bin = fake.file;
    const runner = createHarnessRunner({ config, logger: silent });
    const workdir = path.join(dir, 'work');
    fs.mkdirSync(workdir);
    const handle = runner.launch({ runId: 'run-slow', kind: 'start', dir: workdir, sessionId: null, task: 'x' });
    const sessionId = await handle.sessionId;
    const result = await handle.exited;
    assert.equal(sessionId, 'session-slow');
    assert.equal(result.timedOut, true);
    assert.equal(result.sessionId, 'session-slow');
    assert.deepEqual(classifyHarnessResult(result), { ok: false, category: HARNESS_FAILURE.timeout });
  } finally {
    cleanup(dir);
  }
});

test('spawn 失败不冒充完成', async () => {
  const { dir, config } = makeHarnessConfig();
  try {
    config.harness.bin = path.join(dir, 'no-such-binary');
    const runner = createHarnessRunner({ config, logger: silent });
    const handle = runner.launch({ runId: 'run-spawn', kind: 'start', dir: dir, sessionId: null, task: 'x' });
    const result = await handle.exited;
    assert.ok(result.spawnError, '记录 spawn 失败');
    assert.deepEqual(classifyHarnessResult(result), { ok: false, category: HARNESS_FAILURE.spawnFailed });

    // `.js` 入口不存在时由 Node 报模块缺失：这是 exit 1 的 Harness 失败，不是 spawn 失败。
    const missingJs = makeHarnessConfig();
    try {
      missingJs.config.harness.bin = path.join(missingJs.dir, 'missing-entry.mjs');
      const second = createHarnessRunner({ config: missingJs.config, logger: silent });
      const secondResult = await second.launch({
        runId: 'run-spawn-js',
        kind: 'start',
        dir: missingJs.dir,
        sessionId: null,
        task: 'x',
      }).exited;
      assert.equal(secondResult.spawnError, null);
      assert.deepEqual(classifyHarnessResult(secondResult), { ok: false, category: HARNESS_FAILURE.harnessError });
    } finally {
      cleanup(missingJs.dir);
    }
  } finally {
    cleanup(dir);
  }
});

test('readCapture 只汇总技术事实，供重启后保守恢复使用', async () => {
  const { dir, config } = makeHarnessConfig();
  try {
    const fake = writeFakeHarness(dir, 'ok');
    config.harness.bin = fake.file;
    const runner = createHarnessRunner({ config, logger: silent });
    const workdir = path.join(dir, 'work');
    fs.mkdirSync(workdir);
    const handle = runner.launch({ runId: 'run-capture', kind: 'start', dir: workdir, sessionId: null, task: 'x' });
    await handle.exited;
    const summary = runner.readCapture(path.join(config.runtime.stateDir, 'runs', 'run-capture'));
    assert.deepEqual(summary, {
      exists: true,
      sessionId: 'session-fake',
      turnEndReason: 'completed',
      hadFinal: true,
      hadAssistantCommit: true,
      errorMessage: null,
    });
  } finally {
    cleanup(dir);
  }
});

test('分类器匹配本机实测与本机研报记录的 Harness 错误文本', () => {
  // 前两条为本机 0.2.0-rc.2 隔离 DSH_HOME 实测输出；后两条见并发实测报告的记录。
  assert.deepEqual(
    classifyHarnessResult({
      exitCode: 1,
      errorMessage: 'session "session-x" does not exist; omit --session-id to start a new Session',
    }),
    { ok: false, category: HARNESS_FAILURE.sessionRefused },
  );
  assert.deepEqual(
    classifyHarnessResult({
      exitCode: 1,
      errorMessage: 'a task is required, for example: dsh --profile headless "run the tests"',
    }),
    { ok: false, category: HARNESS_FAILURE.harnessError },
  );
  assert.deepEqual(
    classifyHarnessResult({
      exitCode: 1,
      errorMessage: 'session "session-x" is already owned by an active write handle',
    }),
    { ok: false, category: HARNESS_FAILURE.sessionBusy },
  );
  assert.deepEqual(
    classifyHarnessResult({
      exitCode: 1,
      errorMessage: 'session "session-x" was recorded in "/a", not "/b"',
    }),
    { ok: false, category: HARNESS_FAILURE.sessionRefused },
  );
});

test('probe 依据 pid 与启动时间签名区分仍在运行 / 已退出 / pid 重用', async () => {
  const { dir, config } = makeHarnessConfig();
  try {
    const runner = createHarnessRunner({
      config,
      logger: silent,
      exec: async (bin, args) => {
        if (args.includes('999999')) return { code: 1, stdout: '', stderr: '' };
        if (args.includes('1234')) return { code: 0, stdout: 'Wed Sep 30 10:00:00 2026\n', stderr: '' };
        return { code: 0, stdout: 'Wed Sep 30 11:00:00 2026\n', stderr: '' };
      },
    });
    assert.equal(await runner.probe(999999, 'anything'), 'gone');
    assert.equal(await runner.probe(1234, 'Wed Sep 30 10:00:00 2026'), 'alive');
    assert.equal(await runner.probe(4321, 'Wed Sep 30 10:00:00 2026'), 'reused');
    assert.equal(await runner.probe(1234, null), 'unknown');
    assert.equal(await runner.probe(null, 'x'), 'unknown');
  } finally {
    cleanup(dir);
  }
});
