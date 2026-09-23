// 接单程序入口：加载本机配置，按固定间隔检查已接入仓库的新增评论。
//
//   node src/main.mjs [--config <path>] [--once] [--machine-id <id>] [--capture file|pipe]
//
// `--once` 只跑一轮检查后退出，用于首次核对与隔离测试；缺省按 runtime.pollSeconds 循环。
// 单机只允许一个接单进程：第二个实例会因状态目录里的锁文件而拒绝启动，避免同一任务双写。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkConfig, ConfigError, loadConfig } from './config.mjs';
import { execFileAsync } from './exec.mjs';
import { createGhClient, redact } from './github.mjs';
import { createRunner } from './runner.mjs';

export function parseArgs(argv) {
  const options = { once: false, configPath: undefined, machineId: undefined, capture: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--once') options.once = true;
    else if (arg === '--config') options.configPath = argv[++index];
    else if (arg === '--machine-id') options.machineId = argv[++index];
    else if (arg === '--capture') options.capture = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new ConfigError(`未知参数：${arg}`);
  }
  if (options.capture !== undefined && options.capture !== 'file' && options.capture !== 'pipe') {
    throw new ConfigError(`--capture 只能是 file 或 pipe：${options.capture}`);
  }
  return options;
}

const USAGE = `用法：node src/main.mjs [--config <path>] [--once] [--machine-id <id>] [--capture file|pipe]

  --config      本机配置路径，缺省 .local/config.json
  --once        只检查一轮后退出
  --machine-id  覆盖配置里的执行机标识
  --capture     子进程输出捕获方式，缺省 file（写入日志目录）`;

/** 单实例锁：写 pid，启动时发现锁被活着的进程占着就拒绝启动。 */
export function acquireLock(lockPath) {
  mkdirSync(join(lockPath, '..'), { recursive: true });
  try {
    const existing = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (Number.isInteger(existing?.pid) && processAlive(existing.pid) && existing.pid !== process.pid) {
      throw new ConfigError(`已有接单进程在运行（pid ${existing.pid}，锁 ${lockPath}）；不启动第二个写入者`);
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    // 锁文件损坏或读取失败：按陈旧锁处理，下面直接覆盖。
  }
  writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, 'utf8');
  return () => rmSync(lockPath, { force: true });
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function logLine(stateDir, message) {
  const line = `[${new Date().toISOString()}] ${redact(message)}\n`;
  process.stdout.write(line);
  try {
    mkdirSync(join(stateDir, 'logs'), { recursive: true });
    writeFileSync(join(stateDir, 'logs', `runner-${new Date().toISOString().slice(0, 10)}.log`), line, { flag: 'a' });
  } catch {
    // 本机日志写不进去不影响接单；进程输出仍在终端。
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const config = loadConfig({ configPath: options.configPath, machineId: options.machineId });
  if (options.capture !== undefined) config.runtime.capture = options.capture;
  config.runtime.capture ??= 'file';

  const problems = checkConfig(config);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`配置问题：${problem}\n`);
    return 2;
  }
  mkdirSync(config.runtime.stateDir, { recursive: true });
  const release = acquireLock(join(config.runtime.stateDir, 'runner.lock'));

  const exec = execFileAsync;
  const ghTempDir = join(config.runtime.stateDir, 'tmp');
  let ghCallSeq = 0;
  const gh = createGhClient({
    exec,
    timeoutMs: config.github.timeoutMs,
    pageSize: config.github.pageSize,
    capture: config.runtime.capture,
    outputFiles: (label) => {
      ghCallSeq += 1;
      const stem = `${Date.now()}-${ghCallSeq}-${label}`;
      return {
        stdoutFile: join(ghTempDir, `${stem}.out`),
        stderrFile: join(ghTempDir, `${stem}.err`),
      };
    },
  });
  const runner = createRunner({ config, gh, exec, log: (message) => logLine(config.runtime.stateDir, message) });

  const stopping = { requested: false };
  const onSignal = (signal) => {
    if (stopping.requested) return;
    stopping.requested = true;
    logLine(config.runtime.stateDir, `收到 ${signal}，本轮结束后退出`);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  try {
    logLine(config.runtime.stateDir, `接单启动：执行机 ${config.runnerId}，仓库 ${config.repositories.map((item) => item.repo).join(', ')}`);
    await runner.recover();
    do {
      await runner.cycle();
      if (options.once || stopping.requested) break;
      await sleep(config.runtime.pollSeconds * 1000);
    } while (!stopping.requested);
    logLine(config.runtime.stateDir, '接单退出');
    return 0;
  } finally {
    release();
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    if (error instanceof ConfigError) {
      // 配置问题按可读信息提示，不打印调用栈；用法与示例见 src/README.md 与 config.example.json。
      process.stderr.write(`配置错误：${error.message}\n`);
    } else {
      process.stderr.write(`${redact(error?.stack ?? String(error))}\n`);
    }
    process.exitCode = error instanceof ConfigError ? 2 : 1;
  });
}
