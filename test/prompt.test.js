import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildTaskMessage } from '../src/prompt.js';

const base = {
  repository: 'owner/repo',
  issueNumber: 78,
  sourceType: 'comment',
  sourceId: '12345',
  requester: 'alice',
};

/** 共享核心位于第一个空行之前。 */
function sharedBlock(message) {
  return message.slice(0, message.indexOf('\n\n[')).split('\n');
}

test('START 与 RESUME 都固定 Logical Actor 为 implementer', () => {
  for (const kind of ['start', 'resume']) {
    const message = buildTaskMessage({ ...base, kind });
    assert.match(message, /Logical Actor 固定为 implementer/);
    assert.match(message, /Actor: implementer/);
    assert.match(message, /最终控制命令之前/);
    assert.match(message, /@COORDINATOR/);
    assert.match(message, /@<runnerName>/);
    assert.match(message, /不作为授权/);
  }
});

test('Actor 指令不破坏 START / RESUME 的既有任务坐标与语义区分', () => {
  const start = buildTaskMessage({ ...base, kind: 'start' });
  const resume = buildTaskMessage({ ...base, kind: 'resume' });

  for (const message of [start, resume]) {
    assert.match(message, /Repository: owner\/repo/);
    assert.match(message, /Issue: #78 https:\/\/github\.com\/owner\/repo\/issues\/78/);
    assert.match(message, /Trigger: issue_comment 12345/);
    assert.match(message, /Requester: alice/);
  }
  assert.match(start, /\[START\]/);
  assert.doesNotMatch(start, /\[RESUME\]/);
  assert.match(resume, /\[RESUME\]/);
  assert.doesNotMatch(resume, /\[START\]/);
});

test('prompts.example.json 的 shared 与 Runner 共享核心保持同步', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../prompts.example.json', import.meta.url), 'utf8'));
  const shared = sharedBlock(buildTaskMessage({ ...base, kind: 'start' }));
  assert.deepEqual(example.shared, shared);
  assert.ok(example.shared.some((line) => line.includes('Actor: implementer')));
});
