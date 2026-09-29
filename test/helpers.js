/**
 * 测试替身与临时目录工具。
 *
 * 全部测试默认离线：GitHub 与 Harness 都用替身，只有明确标注的用例才拉起真实子进程。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string} [prefix]
 */
export function tempDir(prefix = 'fjzx-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * @param {string} dir
 */
export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * 构造一份可直接交给 createRunner 的配置。
 * @param {object} [overrides]
 */
export function makeConfig(overrides = {}) {
  const stateDir = overrides.stateDir ?? tempDir('fjzx-state-');
  const repository = {
    repo: 'owner/repo',
    allowedActors: ['alice'],
    sourceDir: overrides.sourceDir ?? tempDir('fjzx-src-'),
    baseBranch: 'main',
    worktreeDir: overrides.worktreeDir ?? path.join(stateDir, 'worktrees'),
    maxConcurrentHarnesses: 1,
    ...(overrides.repository ?? {}),
  };
  return {
    envFile: '/dev/null',
    cwd: process.cwd(),
    runnerName: 'MB01',
    harness: { bin: '/bin/echo', profile: 'headless', home: null, timeoutMs: 0, envAllowlist: [], ...(overrides.harness ?? {}) },
    runtime: {
      stateDir,
      workspaceDir: null,
      pollSeconds: 300,
      maxConcurrentHarnesses: 1,
      capture: 'metadata',
      keepRunLogs: 20,
      ...(overrides.runtime ?? {}),
    },
    github: { timeoutMs: 5_000, pageSize: 50, maxPages: 10, ...(overrides.github ?? {}) },
    gitBin: process.env.FJZX_TEST_GIT_BIN ?? 'git',
    repositories: overrides.repositories ?? [repository],
  };
}

/**
 * 记录调用并按脚本返回结果的 GitHub 替身。
 * @param {Record<string, Function>} [script]
 */
export function createFakeGithub(script = {}) {
  const calls = [];
  const record = (op, payload) => {
    calls.push({ op, ...payload });
  };
  return {
    calls,
    countOf(op) {
      return calls.filter((call) => call.op === op).length;
    },
    async authStatus() {
      record('authStatus', {});
      return 'ok';
    },
    async listOpenIssues(repo, options) {
      record('listOpenIssues', { repo, options });
      return script.listOpenIssues?.(repo, options) ?? { items: [], truncated: false };
    },
    async listIssuesSince(repo, options) {
      record('listIssuesSince', { repo, options });
      return script.listIssuesSince?.(repo, options) ?? { items: [], truncated: false };
    },
    async listComments(repo, issueNumber, options) {
      record('listComments', { repo, issueNumber, options });
      return script.listComments?.(repo, issueNumber, options) ?? { items: [], truncated: false };
    },
    async listRecentComments(repo, issueNumber, options) {
      record('listRecentComments', { repo, issueNumber, options });
      return script.listRecentComments?.(repo, issueNumber, options) ?? [];
    },
    async getIssue(repo, issueNumber) {
      record('getIssue', { repo, issueNumber });
      return script.getIssue?.(repo, issueNumber) ?? { number: issueNumber, comments: 0 };
    },
    async postComment(repo, issueNumber, body) {
      record('postComment', { repo, issueNumber, body });
      return undefined;
    },
  };
}

/**
 * Harness 替身：launch 立即返回已完成的句柄，不拉起真实子进程。
 * @param {object} [plan]
 */
export function createFakeHarness(plan = {}) {
  const launches = [];
  return {
    launches,
    async probe() {
      return plan.probe ?? 'gone';
    },
    async readSignature() {
      return plan.signature ?? 'sig-1';
    },
    readCapture() {
      return plan.capture ?? { exists: true, sessionId: null, turnEndReason: null, hadFinal: false, errorMessage: null };
    },
    finalizeCapture() {},
    launch(input) {
      launches.push(input);
      const result = {
        exitCode: 0,
        signal: null,
        timedOut: false,
        spawnError: null,
        sessionId: 'session-1',
        sessionMismatch: false,
        turnEndReason: 'completed',
        hadAssistantCommit: true,
        hadFinal: true,
        errorMessage: null,
        invalidLines: 0,
        eventCount: 3,
        runDir: input.runDir,
        ...(plan.result ?? {}),
      };
      return {
        pid: plan.pid === undefined ? 4242 : plan.pid,
        record: { sessionMismatch: Boolean(result.sessionMismatch) },
        sessionId: Promise.resolve(result.sessionId),
        earlySignal: Promise.resolve(plan.entered ?? true),
        exited: Promise.resolve(result),
      };
    },
  };
}

/**
 * 工作目录替身：默认直接给出派生目录。
 * @param {object} [plan]
 */
export function createFakeWorkdir(plan = {}) {
  const prepared = [];
  return {
    prepared,
    taskDirFor: (repository, issueNumber) => path.join(repository.worktreeDir, `issue-${issueNumber}`),
    branchFor: (issueNumber) => `fjzx/issue-${issueNumber}`,
    async prepare(input) {
      prepared.push(input);
      if (plan.error) throw plan.error;
      const dir = input.kind === 'resume'
        ? input.binding.dir
        : path.join(input.repository.worktreeDir, `issue-${input.issueNumber}`);
      return { dir, branch: `fjzx/issue-${input.issueNumber}`, source: input.repository.sourceDir, worktreeCreated: false };
    },
  };
}

/**
 * 审计替身。
 */
export function createFakeAudit() {
  const records = [];
  return {
    records,
    append(record) {
      records.push(record);
    },
    events() {
      return records.map((entry) => entry.event);
    },
  };
}

/**
 * 等待 runner 内部不再有本进程管理的运行。
 * @param {{localRunCount: () => number}} runner
 */
export async function waitForIdle(runner, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (runner.localRunCount() > 0) {
    if (Date.now() > deadline) throw new Error('等待 runner 空闲超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 造一个最小 issue 对象。
 * @param {object} overrides
 */
export function makeIssue(overrides = {}) {
  return {
    number: 7,
    title: 't',
    body: '',
    user: { login: 'alice' },
    comments: 0,
    updated_at: '2026-09-30T00:00:00Z',
    ...overrides,
  };
}

/**
 * 造一个最小 comment 对象。
 * @param {object} overrides
 */
export function makeComment(overrides = {}) {
  return {
    id: 100,
    body: '',
    user: { login: 'alice' },
    created_at: '2026-09-30T00:00:00Z',
    updated_at: '2026-09-30T00:00:00Z',
    ...overrides,
  };
}
