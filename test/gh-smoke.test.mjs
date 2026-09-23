import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import test from 'node:test';

import { createGhClient, GhError } from '../src/github.mjs';
import { cleanup, makeTempDir } from './helpers.mjs';

/**
 * 真实 `gh` 冒烟：走生产缺省路径（`execFileAsync` + `capture=file`），对本仓库公开 Issue 发一次
 * 真实读取。它核对的是「命令形态 → 分页 → 解析」这条真实边界，不核对授权数据本身。
 *
 * 未登录 `gh`、无网络或用例被沙箱阻止子进程时跳过并打印原因（跳过 ≠ 通过）；结果只做结构断言，
 * 不绑定具体评论内容。输出文件写在临时目录，不污染仓库。
 */
const REPO = 'cnjimmyshao/fjzx.gh-dev-runner';

function client(dir) {
  return createGhClient({
    capture: 'file',
    outputFiles: (label) => ({
      stdoutFile: join(dir, `${label}.out`),
      stderrFile: join(dir, `${label}.err`),
    }),
  });
}

function skipReason(error) {
  if (!(error instanceof GhError)) return null;
  if (/无法启动|Not Found|HTTP 40[13]|authentication|gh auth login|rate limit|timed out|超时/i.test(error.message)) {
    return `真实 gh 不可用：${error.message}`;
  }
  return null;
}

test('真实 gh：读取仓库 Open Issue 走分页 JSONL 并解析成结构', async (t) => {
  const dir = makeTempDir('fjzx-issue9-gh-');
  t.after(() => cleanup(dir));
  let issues;
  try {
    issues = await client(dir).listOpenIssues({ repo: REPO, label: 'runner:mb01' });
  } catch (error) {
    const reason = skipReason(error);
    if (reason === null) throw error;
    t.skip(reason);
    return;
  }
  assert.ok(Array.isArray(issues));
  for (const issue of issues) {
    assert.equal(typeof issue.number, 'number');
    assert.ok(issue.labels.includes('runner:mb01'), '服务端标签过滤的结果本身也带该标签');
  }
});

test('真实 gh：读取 Issue 评论并解析出 id/作者/链接', async (t) => {
  const dir = makeTempDir('fjzx-issue9-gh-');
  t.after(() => cleanup(dir));
  let comments;
  try {
    comments = await client(dir).listComments({ repo: REPO, issueNumber: 9 });
  } catch (error) {
    const reason = skipReason(error);
    if (reason === null) throw error;
    t.skip(reason);
    return;
  }
  assert.ok(comments.length > 0, 'Issue #9 至少已有一条反馈评论');
  for (const comment of comments) {
    assert.equal(typeof comment.id, 'number');
    assert.equal(typeof comment.body, 'string');
    assert.equal(typeof comment.author, 'string');
  }
  const ids = comments.map((item) => item.id);
  assert.deepEqual(ids, [...ids].sort((left, right) => left - right), '评论按 id 升序返回，进度比较才有意义');
});
