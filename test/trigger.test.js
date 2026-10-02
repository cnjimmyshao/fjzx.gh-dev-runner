import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commentsAfterWatermark,
  evaluateIssueBody,
  isBotFeedback,
  isEligibleControlComment,
  isRunnerCommand,
  pickLatestEligibleComment,
  scanEndpoint,
  triggerIdentity,
} from '../src/trigger.js';
import { makeComment, makeIssue } from './helpers.js';

const options = { runnerName: 'MB01', allowedActors: ['alice', 'Bob'] };

test('正文 trim 后以 @<runnerName> 结尾才算命令', () => {
  assert.equal(isRunnerCommand('请继续处理。 @MB01', 'MB01'), true);
  assert.equal(isRunnerCommand('  请继续处理。\n\n@MB01  \n', 'MB01'), true);
  assert.equal(isRunnerCommand('@MB01 请先讨论，不要执行。', 'MB01'), false);
  assert.equal(isRunnerCommand('@MB02', 'MB01'), false);
  assert.equal(isRunnerCommand(null, 'MB01'), false);
});

test('Actor 标记位于最终控制命令之前时，尾部判定不受影响', () => {
  const withActor = '协调请求见上。\n\n---\nActor: implementer\n\n@MB01';
  assert.equal(isRunnerCommand(withActor, 'MB01'), true);
  const actorAfterCommand = '协调请求见上。\n\n@MB01\n\n---\nActor: implementer';
  assert.equal(isRunnerCommand(actorAfterCommand, 'MB01'), false);
});

test('BOT: 前缀评论永不参与候选选择', () => {
  assert.equal(isBotFeedback('BOT:MB01\n已接单'), true);
  assert.equal(isBotFeedback('  BOT:MB01'), true);
  assert.equal(isBotFeedback('普通讨论 @MB01'), false);
});

test('Issue Body 入口要求作者授权且正文以命令结尾', () => {
  assert.deepEqual(evaluateIssueBody(makeIssue({ body: '做这件事\n\n@MB01' }), options), {
    command: true,
    reason: 'command',
    author: 'alice',
  });
  assert.equal(evaluateIssueBody(makeIssue({ body: '@MB01', user: { login: 'mallory' } }), options).command, false);
  assert.equal(evaluateIssueBody(makeIssue({ body: '@MB01', user: { login: 'mallory' } }), options).reason, 'unauthorized_author');
  assert.equal(evaluateIssueBody(makeIssue({ body: '只是讨论 @MB01 吧' }), options).reason, 'body_not_command');
});

test('授权登录名大小写不敏感', () => {
  assert.equal(
    isEligibleControlComment(makeComment({ body: '@MB01', user: { login: 'BOB' } }), options),
    true,
  );
});

test('整批评论只取最新一条有效控制评论，普通 / 未授权 / BOT 不参与', () => {
  const comments = [
    makeComment({ id: 10, body: '普通讨论', user: { login: 'alice' } }),
    makeComment({ id: 11, body: '执行吧 @MB01', user: { login: 'alice' } }),
    makeComment({ id: 12, body: 'BOT:MB01\n已接单，Session ID: x', user: { login: 'alice' } }),
    makeComment({ id: 13, body: '我来 @MB01', user: { login: 'mallory' } }),
    makeComment({ id: 14, body: '@MB01 讨论一下', user: { login: 'alice' } }),
    makeComment({ id: 15, body: '继续 @MB01', user: { login: 'alice' } }),
  ];
  assert.equal(pickLatestEligibleComment(comments, options).id, 15);
  assert.equal(pickLatestEligibleComment(comments.slice(0, 3), options).id, 11);
  assert.equal(pickLatestEligibleComment(comments.filter((comment) => comment.id === 12), options), null);
});

test('水位之后的评论按 id 过滤，扫描终点取最大 id', () => {
  const comments = [makeComment({ id: 5 }), makeComment({ id: 9 }), makeComment({ id: 12 })];
  assert.deepEqual(commentsAfterWatermark(comments, '9').map((comment) => comment.id), [12]);
  assert.deepEqual(commentsAfterWatermark(comments, null).map((comment) => comment.id), [5, 9, 12]);
  assert.equal(scanEndpoint(commentsAfterWatermark(comments, '9')), '12');
  assert.equal(scanEndpoint([]), null);
});

test('触发来源 identity 稳定且可回查', () => {
  assert.deepEqual(triggerIdentity('issue_body', makeIssue({ number: 3 })), {
    sourceType: 'issue_body',
    sourceId: 'issue-3-body',
    author: 'alice',
  });
  assert.deepEqual(triggerIdentity('comment', makeComment({ id: 99 })), {
    sourceType: 'comment',
    sourceId: '99',
    author: 'alice',
  });
});
