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
 *   node src/index.js resolve-binding --repo owner/name --issue <n> --take-ownership
 */

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ConfigError, checkEnvironment, loadConfig } from './config.js';
import { createGithubClient } from './github.js';
import { createHarnessRunner } from './harness.js';
import { acquireInstanceLock, InstanceLockError } from './instance-lock.js';
import { createAuditLog, createLogger, truncateDiagnostic } from './log.js';
import { createRunner } from './runner.js';
import { StateStore, issueState } from './state.js';
import { branchFor, createWorkdirManager, taskDirFor } from './workdir.js';

/** 收到退出信号后等待正在收尾的运行的宽限期。 */
const SHUTDOWN_GRACE_MS = 5_000;

const USAGE = `用法:
  node src/index.js [--env <path>] [--once] [--wait]
  node src/index.js resolve-run --run <runId> --outcome exited|running [--session <id>]
  node src/index.js resolve-session --repo <owner/name> --issue <n> (--session <id> | --no-session)
  node src/index.js resolve-binding --repo <owner/name> --issue <n> --take-ownership

resolve-session --no-session 表示确认该任务没有可续接的 session：清除 binding.sessionId 与
不明确标记，下一次有效控制评论按 START 新建会话。
resolve-binding --take-ownership 表示维护者明确把该任务的绑定迁移到本机 Runner：runnerName
按本机配置改写，目录 / 分支按本机配置重新派生，原 sessionId 清空。
`;

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = { command: 'run', envFile: null, once: false, wait: false, flags: {} };
  const rest = [...argv];
  while (rest.length > 0) {
    const token = rest.shift();
    // 子命令可以出现在选项前后，便于 `--env <path> resolve-run ...` 这种写法。
    if (token === 'resolve-run' || token === 'resolve-session' || token === 'resolve-binding') {
      options.command = token;
      continue;
    }
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
      case '--take-ownership':
        options.flags.takeOwnership = true;
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

  if (options.command.startsWith('resolve-')) {
    return runResolveCommand(options, config, stdout, deps);
  }

  checkEnvironment(config, deps);
  const store = new StateStore(config.runtime.stateDir);
  store.load();

  const lock = acquireInstanceLock(config.runtime.stateDir, deps);
  // 只要本进程还可能写状态，锁就必须留着：子进程仍在运行时提前释放会让第二个 Runner 同时写 state.json。
  process.once('exit', () => lock.release());
  // 每次写盘前复核锁归属：锁被并发接管后立即停止覆盖状态，而不是继续当第二个写入者。
  store.setOwnershipCheck(() => lock.assertHeld());
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
  let wakePolling = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    wakePolling?.();
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
      if (summary.fatal) {
        exitCode = 2;
        stop();
        break;
      }
      if (options.once) break;
      if (!stopping) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, config.runtime.pollSeconds * 1_000);
          wakePolling = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wakePolling = null;
      }
    } while (!stopping);

    // `--once` 默认等本轮领取的 Harness 结束；收到退出信号时只等一段有限宽限期。
    if (options.once || options.wait || stopping) {
      const deadline = stopping ? Date.now() + SHUTDOWN_GRACE_MS : Number.POSITIVE_INFINITY;
      while (runner.localRunCount() > 0 && Date.now() < deadline) await delay(100);
    }
    if (runner.localRunCount() > 0) {
      logger.warn('仍有 Harness 在运行：本进程退出，这些运行由下次启动按恢复语义接管');
      audit.append({
        event: 'runner_exit_with_active_runs',
        runnerName: config.runnerName,
        pid: process.pid,
        activeRuns: runner.localRunCount(),
      });
      process.exit(exitCode);
    }
    return exitCode;
  } finally {
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    audit.append({ event: 'runner_stopped', runnerName: config.runnerName, pid: process.pid });
    // 还有本进程管理的运行（子进程仍在写事件流、结束后仍会写状态）时不释放锁；
    // 这些运行的监听器会让进程存活到最后一个子进程结束，再由 exit 钩子释放。
    if (runner.localRunCount() === 0) lock.release();
  }
}

async function runCycleSafely(runner, logger, audit) {
  try {
    return await runner.runCycle();
  } catch (error) {
    const fatal = error instanceof InstanceLockError;
    logger.error(`本轮轮询失败: ${truncateDiagnostic(error.message)}`);
    audit.append({
      event: 'cycle_failed',
      diagnostic: truncateDiagnostic(error.message),
      ...(fatal ? { fatal: 'instance_lock_lost' } : {}),
    });
    return {
      claimed: null,
      scanned: [],
      errors: [{ repo: null, message: truncateDiagnostic(error.message) }],
      fatal,
    };
  }
}

/**
 * 人工恢复动作；只在没有活跃 Runner 实例时执行，避免两个写入者。
 * 这里只保证 stateDir 存在，不要求 sourceDir / DSH_BIN 仍然完好——恢复场景下它们可能已经不可用。
 */
async function runResolveCommand(options, config, stdout, deps) {
  fs.mkdirSync(config.runtime.stateDir, { recursive: true });
  const store = new StateStore(config.runtime.stateDir);
  store.load();
  const lock = acquireInstanceLock(config.runtime.stateDir, deps);
  const audit = createAuditLog(config.runtime.stateDir);
  try {
    let code;
    if (options.command === 'resolve-run') {
      code = await resolveRun(options, store, stdout);
    } else if (options.command === 'resolve-binding') {
      code = await resolveBinding(options, config, store, stdout);
    } else {
      code = await resolveSession(options, store, stdout);
    }
    // 人工恢复动作改写了持久化控制状态，必须留下 append-only 审计，事后能回答“谁何时释放 / 确认 / 迁移了什么”。
    audit.append({
      event: 'manual_resolution',
      command: options.command,
      runnerName: config.runnerName,
      pid: process.pid,
      ...describeResolution(options),
    });
    return code;
  } finally {
    lock.release();
  }
}

/**
 * 只记录恢复命令的结构化参数，不复制评论正文或会话标识值。
 * @param {{flags: Record<string, unknown>}} options
 */
function describeResolution(options) {
  const { run, repo, issue, outcome, session, takeOwnership, noSession } = options.flags;
  return {
    runId: run ?? null,
    repository: repo ?? null,
    issueNumber: issue === undefined ? null : Number(issue),
    outcome: outcome ?? null,
    sessionRecorded: typeof session === 'string' ? session : null,
    noSession: noSession === true,
    takeOwnership: takeOwnership === true,
  };
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
      // 确认没有可续接的 session：清掉旧标识与不明确标记，下一次触发按 START 新建。
      issue.binding.sessionId = null;
      issue.binding.sessionUnresolved = false;
    }
    issue.binding.resolvedAt = new Date().toISOString();
  });
  stdout.write(
    `已更新 ${repo}#${issueNumber} 绑定: ${sessionId === null ? '确认无可续接 session（下次按 START）' : `session=${sessionId}`}\n`,
  );
  return 0;
}

/**
 * 维护者明确把绑定迁移到本机 Runner（换机 / 换 runnerName）。
 * 目录与分支按本机配置重新派生，原 session 不再续接，避免在另一台机器的路径与会话上静默继续。
 */
async function resolveBinding(options, config, store, stdout) {
  const repo = options.flags.repo;
  const issueNumber = Number(options.flags.issue);
  if (repo === undefined || !Number.isInteger(issueNumber)) {
    throw new ConfigError('resolve-binding 需要 --repo <owner/name> 与 --issue <n>');
  }
  if (options.flags.takeOwnership !== true) {
    throw new ConfigError('resolve-binding 需要显式 --take-ownership（换 Runner 必须由维护者明确迁移）');
  }
  const repository = config.repositories.find((entry) => entry.repo === repo);
  if (repository === undefined) {
    throw new ConfigError(`${repo} 不在当前 REPOSITORIES_JSON 中`);
  }
  await store.update((draft) => {
    const issue = issueState(draft, repo, issueNumber);
    if (issue.binding === null) throw new ConfigError(`${repo}#${issueNumber} 没有任务绑定`);
    const active = Object.values(draft.activeRuns).find(
      (run) => run.repository === repo && run.issueNumber === issueNumber && ['starting', 'running', 'unknown'].includes(run.status),
    );
    if (active !== undefined) {
      throw new ConfigError(`${repo}#${issueNumber} 仍有占槽的运行 ${active.runId}；先 resolve-run 处理它`);
    }
    const now = new Date().toISOString();
    issue.binding = {
      runnerName: config.runnerName,
      dir: taskDirFor(repository, issueNumber),
      sessionId: null,
      branch: branchFor(issueNumber),
      source: repository.sourceDir,
      worktreeCreated: false,
      createdAt: issue.binding.createdAt ?? now,
      migratedAt: now,
    };
  });
  stdout.write(`已把 ${repo}#${issueNumber} 的绑定迁移给 ${config.runnerName}；下一次触发按 START 建立新 session\n`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

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
