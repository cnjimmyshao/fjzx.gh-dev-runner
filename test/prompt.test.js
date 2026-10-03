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
  assert.match(resume, /按目标项目规则对照最新已合并版本/);
  assert.match(resume, /核对当前生效的 AGENTS \/ Current 是否更新/);
  assert.match(resume, /实际读取生效版本/);
  assert.match(resume, /不要沿用旧分支或 session 中的过时规则/);
  assert.match(resume, /不要把未合并的候选文档当作已生效规范/);
});

test('prompts.example.json 的 shared 与两种模式文案都与 Runner 保持同步', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../prompts.example.json', import.meta.url), 'utf8'));
  const shared = sharedBlock(buildTaskMessage({ ...base, kind: 'start' }));
  assert.deepEqual(example.shared, shared);
  assert.ok(example.shared.some((line) => line.includes('Actor: implementer')));
  for (const kind of ['start', 'resume']) {
    const message = buildTaskMessage({ ...base, kind });
    assert.equal(example[kind].at(-1), message.trimEnd().split('\n').at(-1));
  }
});

test('START 与 RESUME 都明确 Scope Freeze、Finding 判断、回归责任与退出条件', () => {
  for (const kind of ['start', 'resume']) {
    const shared = sharedBlock(buildTaskMessage({ ...base, kind })).join('\n');
    assert.match(shared, /Scope、非目标、Acceptance/);
    assert.match(shared, /普通 Review Finding 不扩大授权，也不解除暂停／冻结/);
    assert.match(shared, /先核实前提、违反的已确认要求与具体后果/);
    assert.match(shared, /已授权范围内的明确缺陷自主修复，额外增强记录 Follow-up/);
    assert.match(shared, /不按 P1\/P2\/P3 标签机械增加代码/);
    assert.match(shared, /有待决事项时，决定前暂停依赖该决定的修改/);
    assert.match(shared, /继续本 Issue 范围内不受影响的工作/);
    assert.match(shared, /等待决定且已无可继续工作时结束本轮调用并保留已有任务/);
    assert.match(shared, /本轮工作正常完成时仍按既有调用语义退出/);
    assert.match(shared, /按已确认 Acceptance 与当前 head 的实际证据判断交付/);
    assert.match(shared, /本 PR 新增代码引入的真实回归仍须处理/);
    assert.match(shared, /不能仅因位于外围工具就称为 Follow-up/);
    assert.match(shared, /可在既有授权内移除不必要的新增实现/);
  }
});
