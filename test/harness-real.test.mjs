import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { execFileAsync } from '../src/exec.mjs';
import { runHarness } from '../src/harness.mjs';
import { cleanup, makeTempDir } from './helpers.mjs';

/**
 * 真实 Harness CLI 的失败路径：不调用模型、不需要凭据。
 *
 * 用真实安装的 `dsh` 启动 headless profile + 本地 overlay，续接一个不存在的会话标识。
 * 期望：退出码 1、结果里不出现新会话标识、失败原因能从本机日志读到（即「不会静默新建
 * 会话」且「失败可见」）。这同时核对 `runHarness` 的调用形态与缺省 file 捕获在本机
 * 真实安装上确实可用。
 *
 * 找不到 dsh 安装、或环境不允许启动子进程时跳过（跳过 ≠ 通过）。绝不安装或升级任何东西，
 * 也不触碰正在运行的 `dsh web`：使用独立的临时 DSH_HOME 与独立工作目录。
 */
function findDshBin() {
  const fromEnv = process.env.FJZX_DSH_BIN;
  if (typeof fromEnv === 'string' && fromEnv !== '' && existsSync(fromEnv)) return fromEnv;
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

test('真实 Harness：续接不存在的会话失败退出，且不静默新建会话', async (t) => {
  const bin = findDshBin();
  if (bin === null) {
    t.skip('本机找不到 dsh 安装（可用 FJZX_DSH_BIN 指定 lib/bin.js）');
    return;
  }
  const patch = join(process.cwd(), 'scripts', 'headless-session', 'overlay.yml');
  if (!existsSync(patch)) {
    t.skip(`找不到 overlay：${patch}`);
    return;
  }

  const root = makeTempDir('fjzx-issue9-dsh-');
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
        patch,
        node: process.execPath,
        home: join(root, 'dsh-home'),
        timeoutMs: 120000,
      },
      exec: execFileAsync,
      cwd,
      task: '这一轮不应调用模型：会话标识不存在，应当在取得凭据前失败。',
      sessionId: 'session-does-not-exist-issue9-test',
      resultPath,
      stdoutPath: join(runDir, 'stdout.log'),
      stderrPath,
      capture: 'file',
    });
  } catch (error) {
    // 子进程无法启动（例如受限环境）：明确跳过而不是假装通过。
    t.skip(`无法启动真实 Harness：${error.message}`);
    return;
  }

  assert.equal(outcome.exitCode, 1, '未知会话必须失败退出');
  assert.equal(outcome.sessionId, null, '不产生新的会话标识，即没有静默新建会话');
  assert.equal(outcome.statusKind, null);
  assert.match(outcome.detail, /not found|不存在|resum/i, `失败原因应当可读：${outcome.detail}`);
  assert.equal(existsSync(stderrPath), true, 'stderr 落本机日志（缺省 file 捕获）');
  assert.match(readFileSync(stderrPath, 'utf8'), /session-does-not-exist-issue9-test/);
});
