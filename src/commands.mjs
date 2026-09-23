// 评论命令解析：把外部评论文本判读成「是否是一条启动／继续命令」。
//
// 首版只接受正文去除首尾空白后恰好等于命令词（缺省 `@dev`）的评论；不做引用、
// 代码块或长评论中的片段解析，也不把被编辑过的评论当成新命令。评论正文在本模块
// 之外不再参与任何命令拼接，只作为任务上下文文本传给 Harness。

/** 去除首尾空白后恰好等于命令词的纯文本评论才算命令。 */
export function parseCommand(body, command = '@dev') {
  if (typeof body !== 'string') return { isCommand: false };
  if (body.trim() !== command) return { isCommand: false };
  return { isCommand: true };
}

/**
 * 从一次评论读取结果中挑出本轮要处理的命令评论。
 *
 * @param {object} input
 * @param {object[]} input.comments 评论数组（GitHub 顺序：旧 → 新）
 * @param {number} input.sinceSeq  已确认处理到的最大评论 id；只处理更大的 id
 * @param {(login: string) => boolean} input.isAuthorized 发起人授权判定
 * @param {string} input.command  命令词
 */
export function collectCommands({ comments, sinceSeq, isAuthorized, command }) {
  const considered = Array.isArray(comments) ? comments : [];
  const newestSeq = considered.reduce(
    (max, item) => (Number.isInteger(item?.id) && item.id > max ? item.id : max),
    Number.isInteger(sinceSeq) ? sinceSeq : 0,
  );
  const commandComments = considered.filter(
    (item) => Number.isInteger(item?.id) && item.id > (sinceSeq ?? 0) && parseCommand(item.body, command).isCommand,
  );
  const selected = [];
  const ignored = [];
  for (const item of commandComments) {
    if (isAuthorized(item.author)) selected.push(item);
    else ignored.push(item);
  }
  // 一条任务只接一条新命令；多余命令不排队，由调用方回报「未启动」。
  return { newestSeq, selected, ignored };
}

/** 命令评论里要进入日志和任务上下文的字段，避免把整条评论对象带进状态文件。 */
export function commandRef(comment) {
  const author = comment?.author ?? '(unknown)';
  return {
    id: comment?.id ?? null,
    author: typeof author === 'string' ? author : String(author?.login ?? author),
    url: comment?.url ?? null,
  };
}

/**
 * 交给 Dev 的启动消息：只说明目标仓库、Issue 与触发评论，并要求 Dev 自己读取目标项目
 * 的规则与最新决定。任务要求不在这里复述。
 */
export function buildTaskPrompt({ repo, issueNumber, issueUrl, command, runnerId }) {
  return [
    `你是通过 GitHub 评论接单启动的 Dev。目标：仓库 ${repo} 的 Issue #${issueNumber}（${issueUrl}）。`,
    `触发命令：${command}，评论 ${command.url}，请求人 @${command.author}，执行机 ${runnerId}。`,
    '',
    '开始前实际读取目标项目的 AGENTS.md、文档导航、docs/current/、相关 Issue 全文与最新评论、',
    '关联 PR 的 Review 与修复记录；不要假设另一个会话已经传入上下文，也不要依据本消息复述需求。',
    '按目标项目规则完成分析、编码、测试与 PR 交付，需要决定或授权的问题回到该 Issue。',
  ].join('\n');
}
