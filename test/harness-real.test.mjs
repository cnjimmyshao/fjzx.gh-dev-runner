import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { execFileAsync } from '../src/exec.mjs';
import { runHarness } from '../src/harness.mjs';
import { cleanup, makeTempDir } from './helpers.mjs';

/**
 * 真实 Harness 的无模型失败路径。
 *
 * 只在本机安装明确支持官方 headless --json / --session-id 时执行；旧版安装明确 skip，
 * 不安装、不升级，也不把「未验证」冒充通过。
 */
function findDshBin(configured) {
  if (typeof process.env.FJZX_DSH_BIN === 'string' && existsSync(process.env.FJZX_DSH_BIN)) {
    return process.env.FJZX_DSH_BIN;
  }
  if (typeof configured === 'string' && existsSync(configured)) return configured;
  const roots = [
    join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache', '_npx'),
    join(homedir(), '.npm', '_npx'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(root, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function dshBinFromConfig() {
  try {
    const configured = loadConfig({}).harness.bin;
    return typeof configured === 'string' && existsSync(configured) ? configured : null;
  } catch {
    return null;
  }
}

test('真实 Harness：官方 --session-id 对未知会话失败，且不静默新建', async (t) => {
  const bin = findDshBin(dshBinFromConfig());
  if (bin === null) {
    t.skip('本机找不到 dsh 安装（可用 FJZX_DSH_BIN 指定 lib/bin.js，或先写好本机 config）');
    return;
  }

  let help;
  try {
    help = await execFileAsync({
      command: process.execPath,
      args: [bin, '--profile', 'headless', '--help'],
      capture: 'pipe',
      timeoutMs: 120000,
    });
  } catch (error) {
    t.skip(`无法启动真实 Harness help：${error.message}`);
    return;
  }
  const helpText = `${help.stdout}\n${help.stderr}`;
  if (!helpText.includes('--session-id') || !helpText.includes('--json')) {
    t.skip('当前本机 Harness headless 仍是旧版，不支持官方 --session-id / --json；本任务不擅自升级');
    return;
  }

  const root = makeTempDir('fjzx-issue19-dsh-');
  t.after(() => cleanup(root));
  const cwd = join(root, 'workdir');
  const runDir = join(root, 'run');
  for (const dir of [cwd, runDir]) mkdirSync(dir, { recursive: true });
  const resultPath = join(runDir, 'result.json');
  const stderrPath = join(runDir, 'stderr.log');

  let outcome;
  try {
    outcome = await runHarness({
      harness: {
        bin,
        profile: 'headless',
        node: process.execPath,
        home: join(root, 'dsh-home'),
        timeoutMs: 120000,
      },
      exec: execFileAsync,
      cwd,
      task: '这一轮不应调用模型：会话标识不存在，应当在模型调用前失败。',
      sessionId: 'session-does-not-exist-issue19-test',
      resultPath,
      stdoutPath: join(runDir, 'stdout.log'),
      stderrPath,
      capture: 'file',
    });
  } catch (error) {
    t.skip(`无法启动真实 Harness：${error.message}`);
    return;
  }

  assert.equal(outcome.exitCode, 1, '未知会话必须失败退出');
  assert.equal(outcome.sessionId, null, '不产生新的 session 事件，即没有静默新建会话');
  assert.equal(outcome.statusKind, 'error');
  assert.match(outcome.detail, /not found|does not exist|不存在|session/i, `失败原因应当可读：${outcome.detail}`);
  assert.equal(existsSync(stderrPath), true, 'stderr 落本机日志（缺省 file 捕获）');
  assert.match(readFileSync(stderrPath, 'utf8'), /session-does-not-exist-issue19-test/);
  assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).sessionId, null);
});
