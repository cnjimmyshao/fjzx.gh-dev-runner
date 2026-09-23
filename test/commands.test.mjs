import { strict as assert } from 'node:assert';
import test from 'node:test';

import { collectCommands, commandRef, parseCommand, buildTaskPrompt } from '../src/commands.mjs';

test('只有去除首尾空白后恰好等于命令词的评论才算命令', () => {
  assert.equal(parseCommand('@dev').isCommand, true);
  assert.equal(parseCommand('  @dev\n').isCommand, true);
  assert.equal(parseCommand('@dev please start').isCommand, false, '长评论里的片段不算命令');
  assert.equal(parseCommand('> @dev').isCommand, false, '引用不算命令');
  assert.equal(parseCommand('```\n@dev\n```').isCommand, false, '代码块不算命令');
  assert.equal(parseCommand('@Dev').isCommand, false, '大小写不匹配不算命令');
  assert.equal(parseCommand('@dev2').isCommand, false);
  assert.equal(parseCommand(null).isCommand, false);
  assert.equal(parseCommand(undefined).isCommand, false);
  assert.equal(parseCommand('   ').isCommand, false);
});

test('命令词可配置，缺省之外的词按同一规则判定', () => {
  assert.equal(parseCommand('@dev', '@bot').isCommand, false);
  assert.equal(parseCommand('@bot', '@bot').isCommand, true);
});

test('只挑选进度之后、作者已授权的命令，并给出最新进度', () => {
  const comments = [
    { id: 1, body: '@dev', author: 'maintainer' },
    { id: 2, body: '@dev', author: 'outsider' },
    { id: 3, body: '讨论', author: 'maintainer' },
    { id: 4, body: '@dev', author: 'maintainer' },
  ];
  const result = collectCommands({
    comments,
    sinceSeq: 1,
    isAuthorized: (login) => login === 'maintainer',
    command: '@dev',
  });
  assert.deepEqual(result.selected.map((item) => item.id), [4]);
  assert.deepEqual(result.ignored.map((item) => item.id), [2]);
  assert.equal(result.newestSeq, 4);
});

test('进度之后没有新评论时不产生命令，进度不倒退', () => {
  const comments = [
    { id: 10, body: '讨论', author: 'maintainer' },
    { id: 11, body: '@dev', author: 'maintainer' },
  ];
  const result = collectCommands({
    comments,
    sinceSeq: 11,
    isAuthorized: () => true,
    command: '@dev',
  });
  assert.equal(result.selected.length, 0);
  assert.equal(result.newestSeq, 11);
});

test('命令引用只带出日志与上下文需要的字段', () => {
  const ref = commandRef({ id: 42, author: 'maintainer', url: 'https://example.invalid/42', body: '@dev' });
  assert.deepEqual(ref, { id: 42, author: 'maintainer', url: 'https://example.invalid/42' });
});

test('启动消息只指向仓库、Issue 与触发评论，不复述需求', () => {
  const task = buildTaskPrompt({
    repo: 'owner/project',
    issueNumber: 9,
    issueUrl: 'https://github.com/owner/project/issues/9',
    command: '@dev',
    trigger: { id: 5, author: 'maintainer', url: 'https://github.com/owner/project/issues/9#issuecomment-5' },
    runnerId: 'mb01',
  });
  assert.ok(task.includes('owner/project'));
  assert.ok(task.includes('Issue #9'));
  assert.ok(task.includes('issuecomment-5'));
  assert.ok(task.includes('mb01'));
  assert.ok(task.includes('AGENTS.md'));
  assert.ok(task.includes('触发命令：@dev'), '命令词本身要出现在消息里');
  assert.ok(!task.includes('[object Object]'), '不能把评论引用对象直接插进文本');
});

test('触发评论没有链接时退回评论 id，不出现 undefined', () => {
  const task = buildTaskPrompt({
    repo: 'owner/project',
    issueNumber: 1,
    issueUrl: 'https://github.com/owner/project/issues/1',
    command: '@dev',
    trigger: { id: 7, author: 'maintainer', url: null },
    runnerId: 'mb01',
  });
  assert.ok(task.includes('评论 id 7'));
  assert.ok(!task.includes('undefined'));
  assert.ok(!task.includes('null'));
});

test('任务消息把评论作者当数据而非命令拼接', () => {
  const task = buildTaskPrompt({
    repo: 'owner/project',
    issueNumber: 1,
    issueUrl: 'https://github.com/owner/project/issues/1',
    command: '@dev',
    trigger: { id: 1, author: 'someone; rm -rf /', url: null },
    runnerId: 'mb01',
  });
  assert.ok(task.includes('rm -rf'), '作者名只作为文本出现');
  assert.ok(task.includes('@someone; rm -rf /'), '原样保留在文本里，不构成命令');
});
