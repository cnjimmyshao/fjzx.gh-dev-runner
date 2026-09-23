// GitHub 通信：复用本机已授权的 `gh`，只读地增量读取接入仓库的 Issue 与评论，并为接单
// 反馈提供最小写回入口。
//
// 读取用 `gh api --paginate -q '.[] | {…}'`：gh 按页取数，jq 把每页数组摊平成「一行一个
// 对象」的 JSONL，因此分页不需要在客户端重组数组。评论正文是外部输入，只作为数据解析
// 或任务上下文文本，不拼成 shell 命令。

import { execFileAsync, ExecError } from './exec.mjs';

export class GhError extends Error {
  constructor(message, { rateLimited = false } = {}) {
    super(message);
    this.name = 'GhError';
    this.rateLimited = rateLimited;
  }
}

const RATE_LIMIT_PATTERN = /rate limit|abuse detection|secondary rate/i;

export function redact(text) {
  return String(text ?? '')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{8,})\b/g, '<redacted>')
    .replace(/\b(github_pat_[A-Za-z0-9_]{8,})\b/g, '<redacted>');
}

function shortError(text) {
  const line = redact(text).split(/\r?\n/).find((item) => item.trim() !== '') ?? '';
  return line.trim().slice(0, 300);
}

/** JSONL：每行一个 JSON 对象，遇到坏行按读取失败处理，不静默跳过。 */
export function parseJsonLines(stdout) {
  const items = [];
  const text = String(stdout ?? '');
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new GhError(`gh 输出不是合法 JSON 行：${error.message}`);
    }
    items.push(value);
  }
  return items;
}

export function normalizeIssue(raw) {
  if (typeof raw?.number !== 'number') throw new GhError('Issue 数据缺少 number 字段');
  return {
    number: raw.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' && raw.url !== '' ? raw.url : `https://github.com/issues/${raw.number}`,
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((label) => label?.name).filter((name) => typeof name === 'string')
      : [],
    assignees: Array.isArray(raw.assignees)
      ? raw.assignees.map((user) => user?.login).filter((login) => typeof login === 'string')
      : [],
    // issues 接口同时返回 Pull Request；这类条目不是 Issue，不参与接单。
    fromPullRequest: raw.pull_request !== undefined && raw.pull_request !== null,
  };
}

export function normalizeComment(raw) {
  if (typeof raw?.id !== 'number') throw new GhError('评论数据缺少 id 字段');
  const login = raw.author?.login;
  return {
    id: raw.id,
    body: typeof raw.body === 'string' ? raw.body : '',
    author: typeof login === 'string' && login !== '' ? login : '(unknown)',
    url: typeof raw.url === 'string' && raw.url !== '' ? raw.url : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

/**
 * @param {object} [options]
 * @param {(options: object) => Promise<{exitCode: number, stdout: string, stderr: string}>} [options.exec]
 *   缺省调用本机 `gh`；测试注入替身即可在不访问 GitHub 的情况下覆盖分页、限流与错读。
 * @param {string} [options.command] gh 可执行入口
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pageSize]
 * @param {'file'|'pipe'} [options.capture] 传给 exec 的输出捕获方式
 * @param {() => {stdoutFile: string, stderrFile: string}} [options.outputFiles]
 *   capture=file 时每次调用的输出落盘位置；缺省用状态目录下的临时文件。
 */
export function createGhClient({
  exec = execFileAsync,
  command = 'gh',
  timeoutMs = 120000,
  pageSize = 50,
  capture = 'file',
  outputFiles,
} = {}) {
  async function run(args, label) {
    const files = capture === 'file' && outputFiles !== undefined ? outputFiles(label) : {};
    try {
      return await exec({ command, args, timeoutMs, capture, ...files });
    } catch (error) {
      if (error instanceof ExecError) throw new GhError(`${command} 调用失败：${error.message}`);
      throw error;
    }
  }

  function checked(result, description) {
    if (result.exitCode === 0) return result;
    const detail = shortError(result.stderr);
    throw new GhError(
      `${description} 退出码 ${result.exitCode}${detail === '' ? '' : `：${detail}`}`,
      { rateLimited: RATE_LIMIT_PATTERN.test(result.stderr) },
    );
  }

  async function apiJsonLines(path, jq, label) {
    const result = checked(
      await run(['api', '-X', 'GET', '--paginate', path, '-q', jq], label),
      `gh api ${path}`,
    );
    return parseJsonLines(result.stdout);
  }

  return {
    /** 只取本仓库已设置本机路由标签的 Open Issue：标签过滤在服务端完成。 */
    async listOpenIssues({ repo, label }) {
      const path = `repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=${pageSize}`;
      const raw = await apiJsonLines(
        path,
        '.[] | {number, title, url: .html_url, labels, assignees, pull_request}',
        'issues',
      );
      return raw.map(normalizeIssue);
    },

    async listComments({ repo, issueNumber }) {
      const path = `repos/${repo}/issues/${issueNumber}/comments?per_page=${pageSize}`;
      const raw = await apiJsonLines(
        path,
        '.[] | {id, body, author: .user, url: .html_url, createdAt: .created_at, updatedAt: .updated_at}',
        'comments',
      );
      return raw.map(normalizeComment);
    },

    /** 反馈回写：失败由调用方记录并如实报告，不让同一次开发任务因此重跑。 */
    async createComment({ repo, issueNumber, body }) {
      const result = checked(
        await run([
          'api', '-X', 'POST', `repos/${repo}/issues/${issueNumber}/comments`,
          '-H', 'Accept: application/vnd.github+json',
          '-f', `body=${body}`,
        ], 'comment'),
        '回写评论',
      );
      const created = result.stdout.trim() === '' ? null : JSON.parse(result.stdout);
      return { id: created?.id ?? null, url: created?.html_url ?? null };
    },
  };
}
