import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { execFileAsync, ExecError } from '../src/exec.mjs';
import { cleanup, makeTempDir } from './helpers.mjs';

/**
 * 这些用例走真实子进程，替换掉的只有「被调用的命令」本身；用来核对缺省输出捕获方式
 * （子进程直接写文件）与超时、启动失败这两条真实路径，而不是替身是否被调用。
 */

function writeChild(root, name, source) {
  const path = join(root, name);
  writeFileSync(path, source, 'utf8');
  return path;
}

test('缺省 file 捕获：子进程输出写到指定文件，调用结束后可读取', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const child = writeChild(root, 'child.mjs', [
    'process.stdout.write("out-1\\n");',
    'process.stderr.write("err-1\\n");',
    'process.exitCode = 0;',
  ].join('\n'));

  const result = await execFileAsync({
    command: process.execPath,
    args: [child],
    stdoutFile: join(root, 'logs', 'stdout.log'),
    stderrFile: join(root, 'logs', 'stderr.log'),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'out-1\n');
  assert.equal(result.stderr, 'err-1\n');
  assert.equal(readFileSync(join(root, 'logs', 'stdout.log'), 'utf8'), 'out-1\n');
  assert.equal(readFileSync(join(root, 'logs', 'stderr.log'), 'utf8'), 'err-1\n');
});

test('任务正文可通过 stdin 传给子进程，同时保留 file 捕获', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const child = writeChild(root, 'stdin.mjs', [
    'process.stdin.setEncoding("utf8");',
    'let text = "";',
    'process.stdin.on("data", (chunk) => { text += chunk; });',
    'process.stdin.on("end", () => process.stdout.write(text));',
  ].join('\n'));

  const result = await execFileAsync({
    command: process.execPath,
    args: [child],
    stdin: '任务正文，不进入命令行参数',
    stdoutFile: join(root, 'stdout.log'),
    stderrFile: join(root, 'stderr.log'),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '任务正文，不进入命令行参数');
});

test('file 捕获同样能带回非零退出码与错误输出', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const child = writeChild(root, 'fail.mjs', 'process.stderr.write("bad things\\n"); process.exit(3);\n');

  const result = await execFileAsync({
    command: process.execPath,
    args: [child],
    stdoutFile: join(root, 'stdout.log'),
    stderrFile: join(root, 'stderr.log'),
  });

  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, 'bad things\n');
});

test('pipe 捕获：输出进内存，不落文件', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const child = writeChild(root, 'echo.mjs', 'process.stdout.write("piped\\n");\n');

  const result = await execFileAsync({ command: process.execPath, args: [child], capture: 'pipe' });
  assert.equal(result.stdout, 'piped\n');
  assert.equal(result.stdoutFile, undefined);
});

test('file 捕获缺少输出路径时拒绝执行', async () => {
  await assert.rejects(
    () => execFileAsync({ command: process.execPath, args: ['-e', ''] }),
    (error) => {
      assert.ok(error instanceof ExecError);
      assert.match(error.message, /stdoutFile/);
      return true;
    },
  );
});

test('超时按调用失败回报，不当作完成', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const child = writeChild(root, 'slow.mjs', 'setTimeout(() => {}, 30000);\n');

  await assert.rejects(
    () => execFileAsync({
      command: process.execPath,
      args: [child],
      timeoutMs: 400,
      stdoutFile: join(root, 'stdout.log'),
      stderrFile: join(root, 'stderr.log'),
    }),
    (error) => {
      assert.ok(error instanceof ExecError);
      assert.equal(error.timedOut, true);
      assert.equal(error.code, 'ETIMEDOUT');
      return true;
    },
  );
});

test('命令不存在属于调用失败并保留错误码', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  mkdirSync(root, { recursive: true });

  await assert.rejects(
    () => execFileAsync({
      command: join(root, 'definitely-not-here.exe'),
      args: [],
      stdoutFile: join(root, 'stdout.log'),
      stderrFile: join(root, 'stderr.log'),
    }),
    (error) => {
      assert.ok(error instanceof ExecError);
      assert.ok(['ENOENT', 'EPERM', 'EACCES'].includes(error.code), `未预期的错误码：${error.code}`);
      if (existsSync(join(root, 'stdout.log'))) {
        assert.equal(readFileSync(join(root, 'stdout.log'), 'utf8'), '');
      }
      return true;
    },
  );
});
