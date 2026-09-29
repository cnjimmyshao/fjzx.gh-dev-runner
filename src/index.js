#!/usr/bin/env node
/**
 * Runner 入口。
 *
 * 常用：
 *   node src/index.js                 # 常驻轮询（runtime.pollSeconds）
 *   node src/index.js --once          # 只跑一个 polling cycle
 *   node src/index.js --once --wait   # 跑一个 cycle，并等本次启动的 Harness 结束
 *
 * 人工恢复（需要 Runner 未在运行）：
 *   node src/index.js resolve-run --run <runId> --outcome exited [--session <id>]
 *   node src/index.js resolve-session --repo owner/name --issue <n> --session <id>
 *   node src/index.js resolve-session --repo owner/name --issue <n> --no-session
 */

import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ConfigError, checkEnvironment, loadConfig } from './config.js';
import { createGithubClient } from './github.js';
import { createHarnessRunner } from './harness.js';
import { acquireInstanceLock, InstanceLockError } from './instance-lock.js';
import { createAuditLog, createLogger, truncateDiagnostic } from './log.js';
import { createRunner } from './runner.js';
import { StateStore, issueState } from './state.js';
import { createWorkdirManager } from './workdir.js';

const USAGE = `用法:
  node src/index.js [--env <path>] [--once] [--wait]
  node src/index.js resolve-run --run <runId> --outcome exited|running [--session <id>]
  node src/index.js resolve-session --repo <owner/name> --issue <n> (--session <id> | --no-session)
`;

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = { command: 'run', envFile: null, once: false, wait: false, flags: {} };
  const rest = [...argv];
  if (rest[0] === 'resolve-run' || rest[0] === 'resolve-session') {
    options.command = rest.shift();
  }
  while (rest.length > 0) {
    const token = rest.shift();
    switch (token) {
      case '--env':
        options.envFile = requireValue(rest, '--env');
        break;
      case '--once':
        options.once = true;
        break;
      case '--wait':
        options.wait = true;
        break;
      case '--run':
      case '--outcome':
      case '--session':
      case '--repo':
      case '--issue':
        options.flags[token.slice(2)] = requireValue(rest, token);
        break;
      case '--no-session':
        options.flags.noSession = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new ConfigError(`未知参数: ${token}`);
    }
  }
  return options;
}

function requireValue(rest, flag) {
  const value = rest.shift();
  if (value === undefined || value.startsWith('--')) {
    throw new ConfigError(`${flag} 需要一个取值`);
  }
  return value;
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const options = parseArgs(argv);
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }

  const config = loadConfig({ envFile: options.envFile ?? undefined });
  const logger = createLogger(`runner:${config.runnerName}`, stdout);

  if (options.command === 'resolve-run' || options.command === 'resolve-session') {
    return runResolveCommand(options, config, stdout, deps);
  }

  checkEnvironment(config, deps);
  const store = new StateStore(config.runtime.stateDir);
  store.load();

  const lock = acquireInstanceLock(config.runtime.stateDir, deps);
  const github = deps.github ?? createGithubClient({
    timeoutMs: config.github.timeoutMs,
    pageSize: config.github.pageSize,
  });
  try {
    await github.authStatus();
  } catch (error) {
    lock.release();
    throw new ConfigError(`gh auth status 失败：请先用执行账户登录 gh（${truncateDiagnostic(error.message)}）`);
  }

  const audit = createAuditLog(config.runtime.stateDir);
  const harness = deps.harness ?? createHarnessRunner({ config, logger });
  const workdir = deps.workdir ?? createWorkdirManager({ gitBin: config.gitBin });
  const runner = createRunner({ config, store, github, harness, workdir, audit, logger });

  audit.append({
    event: 'runner_started',
    runnerName: config.runnerName,
    pid: process.pid,
    node: process.versions.node,
    pollSeconds: config.runtime.pollSeconds,
    maxConcurrentHarnesses: config.runtime.maxConcurrentHarnesses,
    repositories: config.repositories.map((repo) => repo.repo),
  });
  logger.info(`Runner ${config.runnerName} 启动（pid ${process.pid}，轮询 ${config.runtime.pollSeconds}s）`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logger.info('收到退出信号：停止轮询；已在运行的 Harness 不杀，交由下次启动恢复核对');
  };
  const signalHandler = () => stop();
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  try {
    let exitCode = 0;
    do {
      const summary = await runCycleSafely(runner, logger, audit);
      if (summary.errors.length > 0) exitCode = 1;
      if (options.once) break;
      if (!stopping) await delay(config.runtime.pollSeconds * 1_000);
    } while (!stopping);

    if (options.wait) {
      while (runner.localRunCount() > 0) await delay(200);
    }
    return exitCode;
  } finally {
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    audit.append({ event: 'runner_stopped', runnerName: config.runnerName, pid: process.pid });
    lock.release();
  }
}

async function runCycleSafely(runner, logger, audit) {
  try {
    return await runner.runCycle();
  } catch (error) {
    logger.error(`本轮轮询失败: ${truncateDiagnostic(error.message)}`);
    audit.append({ event: 'cycle_failed', diagnostic: truncateDiagnostic(error.message) });
    return { claimed: null, scanned: [], errors: [{ repo: null, message: truncateDiagnostic(error.message) }] };
  }
}

/**
 * 人工恢复动作；只在没有活跃 Runner 实例时执行，避免两个写入者。
 */
async function runResolveCommand(options, config, stdout, deps) {
  const store = new StateStore(config.runtime.stateDir);
  store.load();
  const lock = acquireInstanceLock(config.runtime.stateDir, deps);
  try {
    if (options.command === 'resolve-run') {
      return resolveRun(options, store, stdout);
    }
    return resolveSession(options, store, stdout);
  } finally {
    lock.release();
  }
}

async function resolveRun(options, store, stdout) {
  const runId = options.flags.run;
  const outcome = options.flags.outcome;
  if (runId === undefined || outcome === undefined) {
    throw new ConfigError('resolve-run 需要 --run <runId> 与 --outcome exited|running');
  }
  if (outcome !== 'exited' && outcome !== 'running') {
    throw new ConfigError('resolve-run 的 --outcome 只能是 exited 或 running');
  }
  const sessionId = options.flags.session ?? null;
  await store.update((draft) => {
    const record = draft.activeRuns[runId];
    if (!record) throw new ConfigError(`未知 runId: ${runId}`);
    record.status = outcome === 'running' ? 'running' : 'exited';
    record.lastObservedAt = new Date().toISOString();
    record.manualResolution = { at: record.lastObservedAt, outcome };
    if (outcome === 'exited') record.endedAt = record.lastObservedAt;
    if (sessionId !== null) record.sessionId = sessionId;
    const issue = issueState(draft, record.repository, record.issueNumber);
    if (issue.binding && sessionId !== null && !issue.binding.sessionId) issue.binding.sessionId = sessionId;
  });
  stdout.write(`已按人工恢复更新运行 ${runId}: ${outcome}${sessionId ? ` session=${sessionId}` : ''}\n`);
  return 0;
}

async function resolveSession(options, store, stdout) {
  const repo = options.flags.repo;
  const issueNumber = Number(options.flags.issue);
  if (repo === undefined || !Number.isInteger(issueNumber)) {
    throw new ConfigError('resolve-session 需要 --repo <owner/name> 与 --issue <n>');
  }
  const sessionId = options.flags.session ?? null;
  const noSession = options.flags.noSession === true;
  if (sessionId === null && !noSession) {
    throw new ConfigError('resolve-session 需要 --session <id> 或 --no-session');
  }
  await store.update((draft) => {
    const issue = issueState(draft, repo, issueNumber);
    if (issue.binding === null) throw new ConfigError(`${repo}#${issueNumber} 没有任务绑定`);
    if (sessionId !== null) {
      issue.binding.sessionId = sessionId;
      issue.binding.sessionUnresolved = false;
    } else {
      issue.binding.sessionUnresolved = false;
    }
  });
  stdout.write(
    `已更新 ${repo}#${issueNumber} 绑定: ${sessionId === null ? '确认无遗留会话' : `session=${sessionId}`}\n`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const prefix = error instanceof ConfigError || error instanceof InstanceLockError ? '配置或环境错误' : '运行失败';
      process.stderr.write(`${prefix}: ${error.message}\n`);
      process.exitCode = 1;
    });
}
