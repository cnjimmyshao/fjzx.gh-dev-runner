// 测试辅助：临时状态目录、gh 替身、Harness 调用替身。
//
// 这些替身让「评论读取 → 授权路由 → 绑定 → 调用 → 反馈」整条链路可以在不访问 GitHub、
// 不调用模型、不使用真实会话的情况下重复运行；替换掉的正是进程与网络边界，业务判定逻辑
// 仍是生产代码本身。

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../src/config.mjs';

let counter = 0;

export function makeTempDir(prefix = 'fjzx-issue9-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 临时目录归属由调用方清理；这里只做安全删除。 */
export function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

export function baseConfig({ root, repoDir, sourceDir, runnerId = 'mb01', overrides = {} } = {}) {
  const dir = repoDir ?? join(root, 'task-root');
  mkdirSync(dir, { recursive: true });
  const raw = {
    machineId: runnerId,
    harness: {
      bin: join(root, 'fake-bin.js'),
      patch: join(root, 'overlay.yml'),
      node: process.execPath,
      timeoutMs: 60000,
    },
    runtime: {
      stateDir: join(root, 'state'),
      workspaceDir: join(root, 'workspaces'),
      pollSeconds: 1,
      keepRunLogs: 3,
    },    repositories: [
      {
        repo: 'owner/project',
        allowedActors: ['maintainer'],
        ...(sourceDir === undefined ? { repoDir: dir } : { sourceDir }),
      },
    ],
    ...overrides,
  };
  for (const file of [raw.harness.bin, raw.harness.patch]) {
    mkdirSync(join(file, '..'), { recursive: true });
  }
  return { raw, config: parseConfig(raw, { configPath: join(root, 'config.json') }) };
}
export function makeGh({ issues = [], comments = {}, failIssues = null, failComments = null, onCreate } = {}) {
  const created = [];
  return {
    created,
    calls: { listOpenIssues: 0, listComments: 0, createComment: 0 },
    async listOpenIssues({ repo, label }) {
      this.calls.listOpenIssues++;
      if (failIssues !== null) throw failIssues;
      return issues.filter((issue) => issue.labels.includes(label));
    },
    async listComments({ repo, issueNumber }) {
      this.calls.listComments++;
      if (failComments !== null) throw failComments;
      return comments[`${repo}#${issueNumber}`] ?? [];
    },
    async createComment({ repo, issueNumber, body }) {
      this.calls.createComment++;
      const entry = { repo, issueNumber, body };
      created.push(entry);
      onCreate?.(entry);
      return { id: 9000 + created.length, url: `https://example.invalid/${repo}/${issueNumber}#${created.length}` };
    },
  };
}

/**
 * Harness 调用替身：按 DSH_TASK / DSH_SESSION_ID 决定新建或续接，并把结果 JSON 写进
 * DSH_RESULT_FILE，与 scripts/headless-session 的输出契约一致。
 *
 * 替身只负责这些契约；它**不**代替真实 exec 把 stdout/stderr 写到 options.stdoutFile ——
 * 那正是被测代码要保证的事，之前替身替它写了，才让 file 捕获的缺陷一直没被发现。
 * 真实 file 捕获由 test/exec.test.mjs 走真实子进程覆盖。
 */
export function makeHarnessExec({ newSessionId = () => `session-fake-${++counter}`, exitCode = 0, status = { kind: 'completed' }, spawnThrows = null } = {}) {
  const runs = [];
  const exec = async (options) => {
    if (options.command === 'git') return { exitCode: 0, stdout: '', stderr: '' };
    const env = options.env ?? {};
    if (env.DSH_BIN !== undefined && !env.DSH_BIN.endsWith('fake-bin.js')) {
      throw new Error(`替身只应处理测试配置：DSH_BIN=${env.DSH_BIN}`);
    }
    if (spawnThrows !== null) throw spawnThrows;
    const run = {
      cwd: options.cwd,
      task: env.DSH_TASK ?? null,
      requestedSession: env.DSH_SESSION_ID ?? null,
      capture: options.capture,
      stdoutFile: options.stdoutFile,
      stderrFile: options.stderrFile,
      resultFile: env.DSH_RESULT_FILE ?? null,
    };
    // 缺省 capture=file 时必须给出落盘位置，否则真实 exec 会拒绝执行。
    if (options.capture === 'file' && (options.stdoutFile === undefined || options.stderrFile === undefined)) {
      throw new Error('capture=file 需要同时给出 stdoutFile 与 stderrFile');
    }
    const sessionId = run.requestedSession ?? newSessionId();
    run.sessionId = sessionId;
    runs.push(run);
    if (run.resultFile !== null) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(run.resultFile, `${JSON.stringify({
        sessionId,
        continueReason: run.requestedSession === null ? 'created' : 'resumed',
        status,
        text: '替身回答',
        cwd: options.cwd,
      })}\n`, 'utf8');
    }
    return { exitCode, stdout: `${JSON.stringify({ sessionId })}\n`, stderr: '' };
  };
  return { exec, runs };
}

export function issue(number, label, extra = {}) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/owner/project/issues/${number}`,
    labels: [label],
    assignees: [],
    fromPullRequest: false,
    ...extra,
  };
}

export function comment(id, body, author = 'maintainer', extra = {}) {
  return {
    id,
    body,
    author,
    url: `https://github.com/owner/project/issues/1#issuecomment-${id}`,
    createdAt: '2026-09-23T00:00:00Z',
    updatedAt: '2026-09-23T00:00:00Z',
    ...extra,
  };
}

/**
 * 让某个 Issue 返回给定评论列表。首次接入时这一轮只建立进度基线（把已存在评论登记为
 * 已看过），不会启动任务；测试随后可追加新命令评论，模拟「启动后才发布的命令」。
 */
export function withComments(gh, map) {
  gh.listComments = async ({ repo, issueNumber }) => map[`${repo}#${issueNumber}`] ?? [];
  return gh;
}
