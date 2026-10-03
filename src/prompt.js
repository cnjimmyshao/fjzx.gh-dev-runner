/**
 * Runner → Dev 唤醒消息（docs/current/02-dev-invocation-protocol.md）。
 *
 * 只写入已授权的结构化任务坐标，不复制 Issue / 评论正文、Review、本机路径或凭证。
 * 措辞与 prompts.example.json 的样例保持一致；模板不改变职责边界。
 */

const SHARED = [
  '你是由 fjzx.gh-dev-runner 唤醒来处理一个明确 GitHub Issue 的开发 Dev。',
  '目标仓库当前的 AGENTS.md、docs/current/、关联 Issue 的最新决定、相关 PR / Review 与当前代码状态是权威事实来源。必须实际读取这些来源，不要假设 session 中已有认识仍然最新，也不要把本消息当作需求正文。',
  '按目标项目规则完成分析、编码、测试、提交 PR 与处理 Review；需要 Maintainer 决定或授权的事项回到关联 Issue。',
  '本轮 Dev 的 Logical Actor 固定为 implementer：自己发布的 GitHub 业务评论标记 `Actor: implementer`；若评论末尾承担 `@COORDINATOR` 或 `@<runnerName>` 控制触发，Actor 标记必须位于最终控制命令之前；Actor 标记只是来源说明，不作为授权或 Maintainer 身份凭据。',
  '开始或恢复修改前，依据目标项目规则和 Issue 最新决定核对本次 Scope、非目标、Acceptance 及暂停／冻结要求；先确认边界再修改。普通 Review Finding 不扩大授权，也不解除暂停／冻结。',
  '处理每批 Review Finding 前，先核实前提、违反的已确认要求与具体后果；已授权范围内的明确缺陷自主修复，额外增强记录 Follow-up，并简短记录修复、证据回应、Follow-up 或待决事项的判断依据；不按 P1/P2/P3 标签机械增加代码。',
  '同根因反复出现、补丁持续增加例外或修复将扩大 Scope 时，先复盘责任边界，按目标项目规则在原 Issue 交接需要协调／决定的问题；有待决事项时，决定前暂停依赖该决定的修改；继续本 Issue 范围内不受影响的工作。等待决定且已无可继续工作时结束本轮调用并保留已有任务；本轮工作正常完成时仍按既有调用语义退出。',
  '按已确认 Acceptance 与当前 head 的实际证据判断交付，区分实现、Review 和验收状态；不以所有 Review 评论消失或 P1/P2/P3 清零作为无范围限定的完成条件。真实正确性、安全性问题、既有承诺的缺陷及本 PR 新增代码引入的真实回归仍须处理，不能仅因位于外围工具就称为 Follow-up；可在既有授权内移除不必要的新增实现。',
];

/**
 * @param {object} input
 * @param {'start'|'resume'} input.kind
 * @param {string} input.repository
 * @param {number} input.issueNumber
 * @param {'issue_body'|'comment'} input.sourceType
 * @param {string} input.sourceId
 * @param {string|null} input.requester
 * @returns {string} 通过 stdin 交给 Harness 的任务正文
 */
export function buildTaskMessage(input) {
  const lines = [
    ...SHARED,
    '',
    input.kind === 'resume' ? '[RESUME]' : '[START]',
    `Repository: ${input.repository}`,
    `Issue: #${input.issueNumber} ${issueUrl(input.repository, input.issueNumber)}`,
    `Trigger: ${input.sourceType === 'comment' ? 'issue_comment' : 'issue_body'} ${input.sourceId}`,
    `Requester: ${input.requester ?? 'unknown'}`,
  ];

  if (input.kind === 'resume') {
    lines.push(
      '这是同一任务既有 Harness session 的续接，不是新任务。先重新读取关联 Issue 的最新讨论与决定、现有 PR 的最新 Review 与当前 head；按目标项目规则对照最新已合并版本，核对当前生效的 AGENTS / Current 是否更新并实际读取生效版本，不要沿用旧分支或 session 中的过时规则，也不要把未合并的候选文档当作已生效规范。以 GitHub 与仓库当前状态覆盖 session 中已经过时的认识，然后从现有工作目录、分支和 PR 继续；不要重新从头开发，也不要创建重复 PR。',
    );
  } else {
    lines.push(
      '这是该任务的首次 Harness session。先读取项目 AGENTS、文档导航、Current、Issue 全文与最新评论，并核对是否已有相关分支、PR、Review 或未提交工作。确认当前事实和工作状态后再开始实际开发；不要根据本消息复述或猜测需求，也不要因为是新 session 就忽略仓库已有工作。',
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * @param {string} repository
 * @param {number} issueNumber
 */
export function issueUrl(repository, issueNumber) {
  return `https://github.com/${repository}/issues/${issueNumber}`;
}
