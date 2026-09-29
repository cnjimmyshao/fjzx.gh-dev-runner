import assert from 'node:assert/strict';
import test from 'node:test';

import { GithubError, createGithubClient, defaultExec } from '../src/github.js';

/**
 * 记录 gh 参数并按脚本返回 stdout 的替身执行器；返回值形状与真实 execFile 一致。
 */
function createExec(handler) {
  const calls = [];
  const exec = async (bin, args, options = {}) => {
    calls.push({ bin, args, input: options.input });
    const result = handler(args, options);
    if (result instanceof Error) throw result;
    return { stdout: typeof result === 'string' ? result : JSON.stringify(result), stderr: '' };
  };
  return { exec, calls };
}

test('authStatus 只校验目标 host 的 active account', async () => {
  const { exec, calls } = createExec(() => 'ok');
  const client = createGithubClient({ exec });
  await client.authStatus();
  assert.deepEqual(calls[0].args, ['auth', 'status', '--hostname', 'github.com', '--active']);
});

test('listIssuesSince 组装查询参数、跨页读取并排除 Pull Request', async () => {
  const page1 = Array.from({ length: 2 }, (_, index) => ({ number: index + 1, updated_at: 'u' }));
  const { exec, calls } = createExec((args) => {
    const endpoint = args[args.length - 1];
    if (endpoint.includes('page=1')) return [...page1, { number: 3, pull_request: { url: 'x' } }];
    return [{ number: 4 }];
  });
  const client = createGithubClient({ exec, pageSize: 2, timeoutMs: 1_000 });
  const result = await client.listIssuesSince('owner/repo', { since: '2026-09-30T00:00:00Z', maxPages: 5 });
  assert.deepEqual(result.items.map((item) => item.number), [1, 2, 4]);
  assert.equal(result.truncated, false);
  const endpoint = calls[0].args.at(-1);
  assert.match(endpoint, /^repos\/owner\/repo\/issues\?/);
  assert.match(endpoint, /state=open/);
  assert.match(endpoint, /sort=updated/);
  assert.match(endpoint, /direction=asc/);
  assert.match(endpoint, /since=2026-09-30T00%3A00%3A00Z/);
  assert.match(endpoint, /per_page=2&page=1/);
});

test('分页达到上限时返回 truncated，调用方据此不推进水位', async () => {
  const { exec } = createExec(() => [{ number: 1 }, { number: 2 }]);
  const client = createGithubClient({ exec, pageSize: 2 });
  const result = await client.listIssuesSince('owner/repo', { maxPages: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.items.length, 4);
});

test('listComments 带上 since 参数；空评论返回空数组', async () => {
  const { exec, calls } = createExec(() => []);
  const client = createGithubClient({ exec, pageSize: 50 });
  const result = await client.listComments('owner/repo', 7, { since: '2026-09-30T00:00:00Z' });
  assert.deepEqual(result.items, []);
  assert.match(calls[0].args.at(-1), /^repos\/owner\/repo\/issues\/7\/comments\?/);
  assert.match(calls[0].args.at(-1), /since=2026-09-30T00%3A00%3A00Z/);
});

test('listRecentComments 读取最后一页，用于反馈回查', async () => {
  const { exec, calls } = createExec((args) => {
    if (args.at(-1).includes('/issues/7/comments')) return [{ id: 9 }];
    return { number: 7, comments: 250 };
  });
  const client = createGithubClient({ exec });
  const comments = await client.listRecentComments('owner/repo', 7, { pageSize: 100 });
  assert.deepEqual(comments, [{ id: 9 }]);
  assert.match(calls[1].args.at(-1), /per_page=100&page=3/);
});

test('postComment 用 stdin 传正文，不拼 shell', async () => {
  const { exec, calls } = createExec(() => '');
  const client = createGithubClient({ exec });
  await client.postComment('owner/repo', 7, 'BOT:MB01\n已接单\n');
  assert.deepEqual(calls[0].args, ['issue', 'comment', '7', '--repo', 'owner/repo', '--body-file', '-']);
  assert.equal(calls[0].input, 'BOT:MB01\n已接单\n');
});

test('gh 返回非 JSON 时给出明确错误', async () => {
  const { exec } = createExec(() => 'not json');
  const client = createGithubClient({ exec });
  await assert.rejects(client.getIssue('owner/repo', 7), (error) => error instanceof GithubError);
});

test('defaultExec 通过真实子进程读取 stdout', async () => {
  const result = await defaultExec('/bin/echo', ['hello-gh'], { timeoutMs: 5_000 });
  assert.equal(result.stdout.trim(), 'hello-gh');
});
