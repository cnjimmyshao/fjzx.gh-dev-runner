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

/** 注入用的 GitHub 替身：完全离线，行为由用例决定。 */
function fakeGh({ failRead = null, issues = [] } = {}) {
  const reads = [];
  return {
    reads,
    async listOpenIssues({ repo, label }) {
      reads.push({ repo, label });
      if (failRead !== null) throw failRead;
      return issues;
    },
    async listComments() {
      return [];
    },
    async createComment() {
      return { id: 1, url: 'https://example.invalid/1' };
    },
  };
}

function writeConfig(root, { stateDir, taskDir, machineId = 'mb01' }) {
  const configPath = join(root, 'config.json');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'patch.yml'), '# overlay\n', 'utf8');
  writeFileSync(join(root, 'bin', 'bin.js'), '// 占位入口\n', 'utf8');
  writeFileSync(configPath, `${JSON.stringify({
    machineId,
    harness: {
      bin: join(root, 'bin', 'bin.js'),
      patch: join(root, 'bin', 'patch.yml'),
      node: process.execPath,
      timeoutMs: 60000,
    },
    runtime: { stateDir, capture: 'file' },
    repositories: [{ repo: 'owner/project', allowedActors: ['maintainer'], repoDir: taskDir }],
  }, null, 2)}\n`, 'utf8');
  return configPath;
}

test('--once 在本轮读取失败时以非零退出，并释放实例锁、留下日志', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const stateDir = join(root, 'state');
  const taskDir = join(root, 'task');
  mkdirSync(taskDir, { recursive: true });
  const configPath = writeConfig(root, { stateDir, taskDir });

  const gh = fakeGh({ failRead: new Error('gh api 退出码 1：Not Found (HTTP 404)') });
  const code = await main(['--once', '--config', configPath], { gh });

  assert.equal(code, 1, '读取失败不能静默成功');
  assert.equal(gh.reads.length, 1, '确实读过一次（离线替身，不访问真实 GitHub）');
  assert.equal(existsSync(join(stateDir, 'runner.lock')), false, '退出后释放实例锁');
  assert.equal(existsSync(join(stateDir, 'logs')), true, '本机保留运行日志');
});

test('--once 读取成功时以 0 退出，不启动 Harness', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const stateDir = join(root, 'state');
  const taskDir = join(root, 'task');
  mkdirSync(taskDir, { recursive: true });
  const configPath = writeConfig(root, { stateDir, taskDir });

  const gh = fakeGh({ issues: [] });
  const exec = async () => {
    throw new Error('没有命令时不应调用子进程');
  };
  const code = await main(['--once', '--config', configPath], { gh, exec });
  assert.equal(code, 0);
  assert.equal(gh.reads.length, 1);
});

test('--machine-id 覆盖配置里已有的 machineId', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const stateDir = join(root, 'state');
  const taskDir = join(root, 'task');
  mkdirSync(taskDir, { recursive: true });
  const configPath = writeConfig(root, { stateDir, taskDir, machineId: 'from-config' });

  const gh = fakeGh({ issues: [] });
  await main(['--once', '--config', configPath, '--machine-id', 'from-cli'], { gh });

  // 日志首行记录执行机标识：必须是 --machine-id 的值。
  const logDir = join(stateDir, 'logs');
  const logFile = readdirSync(logDir).find((name) => name.startsWith('runner-'));
  const text = readFileSync(join(logDir, logFile), 'utf8');
  assert.match(text, /执行机 from-cli/, '--machine-id 应当覆盖配置里的值');
  assert.ok(!text.includes('执行机 from-config'), '不再使用配置里的 machineId');
  // 监听标签也应当跟着覆盖后的执行机标识走。
  assert.equal(gh.reads[0].label, 'runner:from-cli');
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
