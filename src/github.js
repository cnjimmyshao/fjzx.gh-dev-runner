/**
 * GitHub 读取与最小回写：统一复用执行账户已认证的本机 `gh`（ADR 0003）。
 *
 * 本模块只负责调用与分页；触发语义由 `trigger.js` 决定，状态由 `state.js` 保存。
 * 所有外部文本都当作数据传递（stdin / 参数数组），不拼 shell。
 */

import { execFile } from 'node:child_process';

export class GithubError extends Error {
  /**
   * @param {string} message
   * @param {{kind?: string, code?: number|string|null, killed?: boolean}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'GithubError';
    this.kind = info.kind ?? 'failed';
    this.code = info.code ?? null;
    this.killed = info.killed ?? false;
  }
}

/**
 * 默认执行器：直接 spawn gh，参数数组传递，结果从 stdout/stderr 读取，不落临时文件。
 * @param {string} bin
 * @param {string[]} args
 * @param {{input?: string, timeoutMs?: number, env?: object, maxBuffer?: number}} options
 */
export function defaultExec(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile(
        bin,
        args,
        {
          encoding: 'utf8',
          timeout: options.timeoutMs,
          env: options.env ?? process.env,
          maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new GithubError(`${bin} ${args[0] ?? ''} 失败: ${firstLine(stderr) || error.message}`, {
                kind: error.killed ? 'timeout' : 'failed',
                code: error.code ?? null,
                killed: Boolean(error.killed),
              }),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    } catch (error) {
      reject(
        new GithubError(`${bin} 无法启动: ${error.code ?? error.message}`, {
          kind: 'spawn_failed',
          code: error.code ?? null,
        }),
      );
      return;
    }
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').find((entry) => entry.trim() !== '');
  return line === undefined ? '' : line.trim();
}

/**
 * @param {object} options
 * @param {string} [options.bin]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pageSize]
 * @param {Function} [options.exec]
 */
export function createGithubClient(options = {}) {
  const bin = options.bin ?? 'gh';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const defaultPageSize = options.pageSize ?? 50;
  const exec = options.exec ?? defaultExec;

  /**
   * @param {string[]} args
   * @param {{input?: string, timeoutMs?: number}} [runOptions]
   */
  async function run(args, runOptions = {}) {
    return exec(bin, args, {
      input: runOptions.input,
      timeoutMs: runOptions.timeoutMs ?? timeoutMs,
      env: process.env,
    });
  }

  /**
   * @param {string} endpoint
   * @returns {Promise<unknown>}
   */
  async function apiGet(endpoint) {
    const { stdout } = await run(['api', '--method', 'GET', endpoint]);
    try {
      return JSON.parse(stdout);
    } catch (error) {
      throw new GithubError(`gh api 返回的不是 JSON: ${error.message}`, { kind: 'invalid_response' });
    }
  }

  /**
   * 分页读取一个数组端点。达到 maxPages 仍可能更多时返回 truncated=true。
   * @param {string} pathname 形如 `repos/owner/name/issues`
   * @param {Record<string, string>} params 额外查询参数
   * @param {{pageSize?: number, maxPages?: number}} [pageOptions]
   */
  async function apiList(pathname, params = {}, pageOptions = {}) {
    const pageSize = pageOptions.pageSize ?? defaultPageSize;
    const maxPages = pageOptions.maxPages ?? 10;
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams({ ...params, per_page: String(pageSize), page: String(page) });
      const batch = await apiGet(`${pathname}?${query.toString()}`);
      if (!Array.isArray(batch)) {
        throw new GithubError('gh api 预期返回数组，实际不是', { kind: 'invalid_response' });
      }
      items.push(...batch);
      if (batch.length < pageSize) return { items, truncated: false };
    }
    // 最后一页恰好填满并不等于一定还有数据；额外探测一页，避免“恰好上限”永久卡住 baseline。
    const probeQuery = new URLSearchParams({ ...params, per_page: String(pageSize), page: String(maxPages + 1) });
    const probe = await apiGet(`${pathname}?${probeQuery.toString()}`);
    if (!Array.isArray(probe)) {
      throw new GithubError('gh api 分页探测预期返回数组，实际不是', { kind: 'invalid_response' });
    }
    return { items, truncated: probe.length > 0 };
  }

  return {
    /**
     * 启动前检查执行账户的本机认证状态（不读取、不转发 token）。
     * 只校验目标 host 的 active account：其他 host 或非活动账户的过期登录不应阻止 Runner 启动。
     * @param {string} [host]
     */
    async authStatus(host = options.host ?? 'github.com') {
      const { stdout } = await run(['auth', 'status', '--hostname', host, '--active']);
      return stdout;
    },

    /**
     * 列出 `since` 之后有更新、且当前仍打开的 Issue（排除 Pull Request）。
     * @param {string} repo
     * @param {{since?: string|null, pageSize?: number, maxPages?: number}} [listOptions]
     */
    async listIssuesSince(repo, listOptions = {}) {
      const params = { state: 'open', sort: 'updated', direction: 'asc' };
      if (listOptions.since) params.since = listOptions.since;
      const result = await apiList(`repos/${repo}/issues`, params, listOptions);
      return {
        items: result.items.filter((item) => item.pull_request === undefined),
        truncated: result.truncated,
      };
    },

    /**
     * 列出该仓库当前全部 Issue（open + closed；baseline 用，排除 PR），确保未来 reopen 不复活历史命令。
     * @param {string} repo
     * @param {{pageSize?: number, maxPages?: number}} [listOptions]
     */
    async listOpenIssues(repo, listOptions = {}) {
      const result = await apiList(
        `repos/${repo}/issues`,
        { state: 'all', sort: 'updated', direction: 'asc' },
        listOptions,
      );
      return {
        items: result.items.filter((item) => item.pull_request === undefined),
        truncated: result.truncated,
      };
    },

    /**
     * 读取单个 Issue（含 body 与评论数）。
     * @param {string} repo
     * @param {number} issueNumber
     */
    async getIssue(repo, issueNumber) {
      return apiGet(`repos/${repo}/issues/${issueNumber}`);
    },

    /**
     * 读取某个 Issue 在 `since` 之后的评论（按创建顺序升序）。
     * @param {string} repo
     * @param {number} issueNumber
     * @param {{since?: string|null, pageSize?: number, maxPages?: number}} [listOptions]
     */
    async listComments(repo, issueNumber, listOptions = {}) {
      const params = {};
      if (listOptions.since) params.since = listOptions.since;
      return apiList(`repos/${repo}/issues/${issueNumber}/comments`, params, listOptions);
    },

    /**
     * 读取某个 Issue 最近的一页评论，用于重启后核对反馈是否已经存在。
     * @param {string} repo
     * @param {number} issueNumber
     * @param {{pageSize?: number, total?: number}} [listOptions]
     */
    async listRecentComments(repo, issueNumber, listOptions = {}) {
      const pageSize = listOptions.pageSize ?? 100;
      let total = listOptions.total;
      if (total === undefined) {
        const issue = await apiGet(`repos/${repo}/issues/${issueNumber}`);
        total = Number(issue.comments ?? 0);
      }
      if (!Number.isFinite(total) || total <= 0) return [];
      const lastPage = Math.max(1, Math.ceil(total / pageSize));
      const batch = await apiGet(
        `repos/${repo}/issues/${issueNumber}/comments?per_page=${pageSize}&page=${lastPage}`,
      );
      return Array.isArray(batch) ? batch : [];
    },

    /**
     * 回写一条 Runner 控制反馈；正文通过 stdin 传递。
     * @param {string} repo
     * @param {number} issueNumber
     * @param {string} body
     */
    async postComment(repo, issueNumber, body) {
      await run(['issue', 'comment', String(issueNumber), '--repo', repo, '--body-file', '-'], { input: body });
    },
  };
}
