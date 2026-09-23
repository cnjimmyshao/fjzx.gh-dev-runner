import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigError } from '../src/config.mjs';
import { acquireLock, main, parseArgs, processAlive } from '../src/main.mjs';
import { cleanup, makeTempDir } from './helpers.mjs';

test('命令行参数解析：只接受已知开关，值缺失或越界明确失败', () => {
  assert.deepEqual(parseArgs([]), { once: false, configPath: undefined, machineId: undefined, capture: undefined });
  assert.equal(parseArgs(['--once']).once, true);
  assert.equal(parseArgs(['--config', 'a.json']).configPath, 'a.json');
  assert.equal(parseArgs(['--machine-id', 'mb01']).machineId, 'mb01');
  assert.equal(parseArgs(['--capture', 'pipe']).capture, 'pipe');
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--capture', 'socket']), /--capture/);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
});

test('单实例锁：活着的进程占用时拒绝启动，陈旧锁可接管并在退出后释放', () => {
  const root = makeTempDir();
  try {
    const lock = join(root, 'runner.lock');
    // 另起一个真实存活的进程充当「已有实例」；本进程自身会被锁逻辑视为同一个执行者。
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    try {
      writeFileSync(lock, JSON.stringify({ pid: holder.pid, at: 'now' }), 'utf8');
      assert.equal(processAlive(holder.pid), true);
      assert.throws(() => acquireLock(lock), /已有接单进程在运行/);
    } finally {
      holder.kill();
    }

    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 'now' }), 'utf8');
    const release = acquireLock(lock);
    assert.equal(existsSync(lock), true);
    release();
    assert.equal(existsSync(lock), false, '正常退出后释放锁');

    // 陈旧锁（进程已不存在）不阻塞启动。
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: 'old' }), 'utf8');
    const release2 = acquireLock(lock);
    assert.deepEqual(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
    release2();
  } finally {
    cleanup(root);
  }
});

test('--once 在读取失败时以非零退出，并释放实例锁、留下日志', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const stateDir = join(root, 'state');
  const taskDir = join(root, 'task');
  mkdirSync(taskDir, { recursive: true });
  const configPath = join(root, 'config.json');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'patch.yml'), '# overlay\n', 'utf8');
  writeFileSync(join(root, 'bin', 'bin.js'), '// 占位入口\n', 'utf8');
  writeFileSync(configPath, `${JSON.stringify({
    machineId: 'mb01',
    harness: {
      bin: join(root, 'bin', 'bin.js'),
      patch: join(root, 'bin', 'patch.yml'),
      node: process.execPath,
      timeoutMs: 60000,
    },
    runtime: { stateDir, capture: 'file' },
    // 这个仓库不存在：gh 会失败，--once 必须因此以非零退出（核对配置与授权就是这个用途）。
    repositories: [{ repo: 'owner/does-not-exist-probe', allowedActors: ['maintainer'], repoDir: taskDir }],
  }, null, 2)}\n`, 'utf8');

  const code = await main(['--once', '--config', configPath]);
  assert.equal(code, 1, '读取失败不能静默成功');
  assert.equal(existsSync(join(stateDir, 'runner.lock')), false, '退出后释放实例锁');
  assert.equal(existsSync(join(stateDir, 'logs')), true, '本机保留运行日志');
});

test('--machine-id 覆盖配置里已有的 machineId', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const stateDir = join(root, 'state');
  const taskDir = join(root, 'task');
  mkdirSync(taskDir, { recursive: true });
  const configPath = join(root, 'config.json');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'patch.yml'), '# overlay\n', 'utf8');
  writeFileSync(join(root, 'bin', 'bin.js'), '// 占位入口\n', 'utf8');
  writeFileSync(configPath, `${JSON.stringify({
    machineId: 'from-config',
    harness: {
      bin: join(root, 'bin', 'bin.js'),
      patch: join(root, 'bin', 'patch.yml'),
      node: process.execPath,
    },
    runtime: { stateDir, capture: 'file' },
    repositories: [{ repo: 'owner/does-not-exist-probe', allowedActors: ['maintainer'], repoDir: taskDir }],
  }, null, 2)}\n`, 'utf8');

  // 日志首行记录执行机标识：用覆盖值启动，日志里必须是 --machine-id 的值。
  await main(['--once', '--config', configPath, '--machine-id', 'from-cli']);
  const logDir = join(stateDir, 'logs');
  const logFile = readdirSync(logDir).find((name) => name.startsWith('runner-'));
  const text = readFileSync(join(logDir, logFile), 'utf8');
  assert.match(text, /执行机 from-cli/, '--machine-id 应当覆盖配置里的值');
  assert.ok(!text.includes('执行机 from-config'), '不再使用配置里的 machineId');
});

test('配置缺失或非法时以配置错误退出', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  await assert.rejects(
    () => main(['--once', '--config', join(root, 'missing.json')]),
    /读取配置失败/,
  );
  await assert.rejects(
    () => main(['--capture', 'nope']),
    (error) => error instanceof ConfigError,
  );
});
