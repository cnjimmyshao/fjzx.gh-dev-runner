import { strict as assert } from 'node:assert';
import test from 'node:test';

import { ExecError } from '../src/exec.mjs';
import { createGhClient, GhError, normalizeComment, normalizeIssue, parseJsonLines, redact } from '../src/github.mjs';

/** 记录参数并逐次返回预置结果的 gh 替身。 */
function fakeGh(responses) {
  const calls = [];
  const exec = async (options) => {
    calls.push(options);
    const next = responses.shift();
    if (next === undefined) throw new Error('替身没有更多响应');
    if (typeof next === 'function') return next(options);
    return { exitCode: 0, stdout: '', stderr: '', ...next };
  };
  return { exec, calls };
}

test('读取 Open Issue 时按仓库标签在服务端过滤并逐行解析 JSONL', async () => {
  const { exec, calls } = fakeGh([
    {
      stdout: [
        JSON.stringify({ number: 9, title: 't', url: 'https://github.com/o/p/issues/9', labels: [{ name: 'runner:mb01' }], assignees: [{ login: 'a' }] }),
        JSON.stringify({ number: 10, title: 'u', url: 'https://github.com/o/p/issues/10', labels: [], assignees: [] }),
      ].join('\n'),
    },
  ]);
  const gh = createGhClient({ exec, capture: 'pipe' });
  const issues = await gh.listOpenIssues({ repo: 'owner/project', label: 'runner:mb01' });

  assert.equal(issues.length, 2);
  assert.equal(issues[0].number, 9);
  assert.deepEqual(issues[0].labels, ['runner:mb01']);
  const args = calls[0].args;
  assert.ok(args.includes('--paginate'), '分页交给 gh');
  assert.ok(args.some((arg) => arg.includes('state=open')), '只取 Open Issue');
  assert.ok(args.some((arg) => arg.includes('labels=runner%3Amb01')), '标签在服务端过滤，冒号做 URI 编码');
  assert.ok(args.includes('-q'), '用 jq 把每页数组摊平成 JSONL');
  assert.equal(calls[0].command, 'gh');
});

test('评论读取走 issues/<n>/comments 分页接口', async () => {
  const { exec, calls } = fakeGh([
    { stdout: `${JSON.stringify({ id: 5, body: '@dev', author: { login: 'maintainer' }, url: 'https://x/5' })}\n` },
  ]);
  const gh = createGhClient({ exec, capture: 'pipe' });
  const comments = await gh.listComments({ repo: 'owner/project', issueNumber: 9 });
  assert.deepEqual(comments, [{ id: 5, body: '@dev', author: 'maintainer', url: 'https://x/5' }]);
  assert.ok(calls[0].args.some((arg) => arg.includes('repos/owner/project/issues/9/comments')));
});

test('分页返回多行 JSONL 时全部保留', async () => {
  const lines = [
    JSON.stringify({ id: 1, body: 'a', author: { login: 'u' }, url: null }),
    JSON.stringify({ id: 2, body: 'b', author: { login: 'u' }, url: null }),
    JSON.stringify({ id: 3, body: 'c', author: { login: 'u' }, url: null }),
  ];
  assert.equal(parseJsonLines(`${lines.join('\n')}\n`).length, 3);
  assert.deepEqual(parseJsonLines(''), []);
});

test('坏 JSON 行按读取失败处理，不静默跳过', () => {
  assert.throws(() => parseJsonLines('{"id":1}\n不是 JSON'), GhError);
});

test('非零退出带上错误摘要，并识别限流', async () => {
  const limited = fakeGh([{ exitCode: 1, stdout: '', stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }]);
  const gh = createGhClient({ exec: limited.exec, capture: 'pipe' });
  await assert.rejects(
    () => gh.listOpenIssues({ repo: 'owner/project', label: 'runner:mb01' }),
    (error) => {
      assert.ok(error instanceof GhError);
      assert.equal(error.rateLimited, true);
      assert.match(error.message, /rate limit/);
      return true;
    },
  );
});

test('未登录或无权限的失败文本进入错误信息', async () => {
  const denied = fakeGh([{ exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }]);
  const gh = createGhClient({ exec: denied.exec, capture: 'pipe' });
  await assert.rejects(() => gh.listComments({ repo: 'owner/project', issueNumber: 9 }), /HTTP 404/);
});

test('gh 无法启动属于调用失败而不是空结果', async () => {
  const exec = async () => {
    throw new ExecError('gh 无法启动：spawn gh ENOENT', { code: 'ENOENT' });
  };
  const gh = createGhClient({ exec, capture: 'pipe' });
  await assert.rejects(() => gh.listOpenIssues({ repo: 'owner/project', label: 'x' }), GhError);
});

test('回写评论用 POST，返回可核对的链接', async () => {
  const { exec, calls } = fakeGh([{ stdout: JSON.stringify({ id: 77, html_url: 'https://github.com/o/p/issues/9#issuecomment-77' }) }]);
  const gh = createGhClient({ exec, capture: 'pipe' });
  const created = await gh.createComment({ repo: 'owner/project', issueNumber: 9, body: '已接单' });
  assert.deepEqual(created, { id: 77, url: 'https://github.com/o/p/issues/9#issuecomment-77' });
  assert.ok(calls[0].args.includes('POST'));
  assert.ok(calls[0].args.some((arg) => arg === 'body=已接单'), '正文作为单个参数传递，不拼 shell');
});

test('字段缺失或类型不符的数据被拒绝，不猜默认值', () => {
  assert.throws(() => normalizeIssue({ title: 'no number' }), /number/);
  assert.throws(() => normalizeComment({ body: 'no id' }), /id/);
  const issue = normalizeIssue({ number: 3, labels: [{ name: 'a' }, null], assignees: 'x' });
  assert.deepEqual(issue.labels, ['a']);
  assert.deepEqual(issue.assignees, []);
  assert.equal(normalizeComment({ id: 1, body: null, user: null }).body, '');
  assert.equal(normalizeComment({ id: 1, body: 'x' }).author, '(unknown)');
});

test('日志与错误文本里的 token 形态被脱敏', () => {
  const text = 'token ghp_abcdefghijklmnop and github_pat_11ABCDEFG0_abcdefghij';
  const masked = redact(text);
  assert.ok(!masked.includes('ghp_abcdefghijklmnop'));
  assert.ok(!masked.includes('github_pat_11ABCDEFG0_abcdefghij'));
  assert.ok(masked.includes('<redacted>'));
});
