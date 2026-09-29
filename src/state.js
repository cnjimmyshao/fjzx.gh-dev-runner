/**
 * Runner 本机状态：`<stateDir>/state.json` 的读写、条件式原子更新与容量记账。
 *
 * 语义依据 docs/current/04-local-state.md 与 05-harness-scheduling.md：
 * - 任务主键是 repository + issueNumber；
 * - 领取更新必须在同一临界区内条件式地同时写入水位／Body 已处理与 starting；
 * - 状态文件用“临时文件 + rename”原子替换；无法可靠解析时不得静默覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';

export const STATE_VERSION = 1;
export const STATE_FILE = 'state.json';
export const ACTIVE_STATUSES = Object.freeze(['starting', 'running', 'unknown']);
const ACTIVE = new Set(ACTIVE_STATUSES);
const ENDED_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateError';
  }
}

/** 条件式更新未通过条件时抛出；调用方据此重新读取，而不是当成故障。 */
export class ConditionFailed extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConditionFailed';
  }
}

/**
 * @param {object} [seed]
 * @returns {object} 全新的 v1 状态
 */
export function createEmptyState() {
  return { version: STATE_VERSION, activeRuns: {}, repositories: {}, scheduler: { repoCursor: 0 } };
}

/**
 * @param {unknown} value
 * @returns {object} 校验后的状态
 */
export function validateState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StateError('state.json 顶层必须是对象');
  }
  if (value.version !== STATE_VERSION) {
    throw new StateError(`不支持的 state.json version: ${JSON.stringify(value.version)}`);
  }
  if (value.activeRuns === null || typeof value.activeRuns !== 'object' || Array.isArray(value.activeRuns)) {
    throw new StateError('state.json activeRuns 必须是对象');
  }
  if (value.repositories === null || typeof value.repositories !== 'object' || Array.isArray(value.repositories)) {
    throw new StateError('state.json repositories 必须是对象');
  }
  const recoverableStatuses = new Set(['starting', 'running', 'unknown', 'exited']);
  for (const [runId, run] of Object.entries(value.activeRuns)) {
    if (run === null || typeof run !== 'object' || Array.isArray(run)) {
      throw new StateError(`activeRuns.${runId} 必须是对象`);
    }
    if (typeof run.runId !== 'string' || run.runId !== runId
      || typeof run.repository !== 'string'
      || !Number.isInteger(run.issueNumber)
      || !recoverableStatuses.has(run.status)) {
      throw new StateError(`activeRuns.${runId} 缺少保守恢复所需字段`);
    }
    if (run.status === 'running' && (!Number.isInteger(run.pid) || run.pid <= 0)) {
      throw new StateError(`activeRuns.${runId} 的 running 状态缺少有效 pid`);
    }
  }
  return value;
}

/**
 * 串行化状态读写的单写入者存储。Runner 同一时刻只有一个实例持有 stateDir 锁，
 * 因此进程内串行 + 原子替换即可满足 Current 的原子与条件要求。
 */
export class StateStore {
  #file;
  #state;
  #chain = Promise.resolve();

  /** @param {string} stateDir */
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.#file = path.join(stateDir, STATE_FILE);
    this.#state = null;
  }

  get file() {
    return this.#file;
  }

  /** 文件不存在视为首次接入；存在但无法解析或版本不支持时拒绝启动。 */
  load() {
    let text;
    try {
      text = fs.readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.#state = createEmptyState();
        return this.#state;
      }
      throw new StateError(`无法读取 ${STATE_FILE}: ${error.code ?? error.message}`);
    }
    if (text.trim() === '') {
      throw new StateError(`${STATE_FILE} 存在但为空，拒绝当成新状态覆盖`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new StateError(`${STATE_FILE} 无法解析为 JSON: ${error.message}`);
    }
    this.#state = validateState(parsed);
    return this.#state;
  }

  /** 只读视图；调用方不得直接修改。 */
  read() {
    if (this.#state === null) throw new StateError('状态尚未加载');
    return this.#state;
  }

  /**
   * 在串行临界区内执行条件式更新。mutator 抛错（含 ConditionFailed）时不写盘。
   * mutator 内只做内存判断与赋值；GitHub / 子进程 I/O 必须在临界区之外先完成。
   * @template T
   * @param {(draft: object) => T} mutator
   * @returns {Promise<T>}
   */
  update(mutator) {
    const task = this.#chain.then(() => {
      const draft = structuredClone(this.read());
      const result = mutator(draft);
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        throw new StateError('状态更新必须同步完成，不得在临界区内 await');
      }
      this.#write(draft);
      this.#state = draft;
      return result;
    });
    this.#chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** @param {object} draft */
  #write(draft) {
    const tmp = `${this.#file}.tmp-${process.pid}`;
    // state.json 含私有仓库身份、本机路径与 session 标识，与 audit / runs / lock 一致用 0600。
    const handle = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(draft, null, 2)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmp, this.#file);
  }
}

/** 机器级活跃 Harness 数（starting / running / unknown 都占槽）。 */
export function machineActiveCount(state) {
  return Object.values(state.activeRuns).filter((run) => ACTIVE.has(run.status)).length;
}

/** 仓库级活跃 Harness 数。 */
export function repoActiveCount(state, repo) {
  return Object.values(state.activeRuns).filter((run) => run.repository === repo && ACTIVE.has(run.status)).length;
}

/** 某个 Issue 是否已有 Harness 处于 starting / running / unknown。 */
export function activeRunForIssue(state, repo, issueNumber) {
  return (
    Object.values(state.activeRuns).find(
      (run) => run.repository === repo && run.issueNumber === issueNumber && ACTIVE.has(run.status),
    ) ?? null
  );
}

/**
 * 读取（不存在则初始化）某个仓库 + Issue 的触发进度。
 * @param {object} state
 * @param {string} repo
 * @param {number} issueNumber
 */
export function issueState(state, repo, issueNumber) {
  const repository = repositoryState(state, repo);
  const key = String(issueNumber);
  if (repository.issues[key] === undefined) {
    repository.issues[key] = {
      issueBodyHandled: false,
      commentScanWatermark: null,
      commentScanWatermarkAt: null,
      lastTrigger: null,
      binding: null,
      lastRun: null,
    };
  }
  return repository.issues[key];
}

/**
 * @param {object} state
 * @param {string} repo
 */
export function repositoryState(state, repo) {
  if (state.repositories[repo] === undefined) {
    state.repositories[repo] = {
      baselineCompleted: false,
      baselineCompletedAt: null,
      lastScanAt: null,
      issues: {},
    };
  }
  return state.repositories[repo];
}

/**
 * 清理已经结束且超过保留期的运行记录；不影响仍占槽的运行。
 * @param {object} state
 * @param {number} [now]
 */
export function pruneEndedRuns(state, now = Date.now()) {
  for (const [runId, run] of Object.entries(state.activeRuns)) {
    if (ACTIVE.has(run.status)) continue;
    const endedAt = Date.parse(run.endedAt ?? run.startedAt ?? '') || 0;
    if (now - endedAt > ENDED_RUN_RETENTION_MS) delete state.activeRuns[runId];
  }
}
