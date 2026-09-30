/**
 * Trigger 语义的纯函数部分（docs/current/03-runner-trigger.md）。
 *
 * 这里只判断“什么算一次执行请求”；水位推进、原子领取与 spawn 由 runner 负责。
 * 不解析 Markdown、识别不了引用块与代码块，也不依赖 GitHub mention 事件。
 */

/** Runner 自动反馈的保留前缀；任何以它开头的评论永不参与候选选择。 */
export const BOT_PREFIX = 'BOT:';

/**
 * 正文 trim 后是否以 `@<runnerName>` 结尾。
 * @param {string|null|undefined} text
 * @param {string} runnerName
 */
export function isRunnerCommand(text, runnerName) {
  if (typeof text !== 'string') return false;
  return text.trim().endsWith(`@${runnerName}`);
}

/**
 * @param {string|null|undefined} text
 */
export function isBotFeedback(text) {
  if (typeof text !== 'string') return false;
  return text.trimStart().startsWith(BOT_PREFIX);
}

/**
 * GitHub 登录名大小写不敏感。
 * @param {string|null|undefined} login
 * @param {string[]} allowedActors
 */
export function isAuthorizedActor(login, allowedActors) {
  if (typeof login !== 'string' || login === '') return false;
  const candidate = login.toLowerCase();
  return allowedActors.some((actor) => actor.toLowerCase() === candidate);
}

/**
 * 判断 Issue 初始 Body 是否构成一次执行请求。
 * @param {{user?: {login?: string}, body?: string|null}} issue
 * @param {{runnerName: string, allowedActors: string[]}} options
 */
export function evaluateIssueBody(issue, options) {
  const author = issue?.user?.login ?? null;
  if (!isAuthorizedActor(author, options.allowedActors)) {
    return { command: false, reason: 'unauthorized_author', author };
  }
  if (!isRunnerCommand(issue?.body, options.runnerName)) {
    return { command: false, reason: 'body_not_command', author };
  }
  return { command: true, reason: 'command', author };
}

/**
 * 单条评论是否是有效的 `@<runnerName>` 控制评论。
 * @param {{user?: {login?: string}, body?: string|null}} comment
 * @param {{runnerName: string, allowedActors: string[]}} options
 */
export function isEligibleControlComment(comment, options) {
  if (isBotFeedback(comment?.body)) return false;
  if (!isAuthorizedActor(comment?.user?.login, options.allowedActors)) return false;
  return isRunnerCommand(comment?.body, options.runnerName);
}

/**
 * 本轮读取快照中只取最新一条有效控制评论；普通、未授权与 `BOT:` 评论不参与。
 * @param {Array<object>} comments
 * @param {{runnerName: string, allowedActors: string[]}} options
 */
export function pickLatestEligibleComment(comments, options) {
  let picked = null;
  for (const comment of comments) {
    if (!isEligibleControlComment(comment, options)) continue;
    if (picked === null || compareIds(comment.id, picked.id) > 0) picked = comment;
  }
  return picked;
}

/**
 * 水位之后的评论：comment id 严格大于水位 identity。水位为空表示全部为本轮新读取。
 * @param {Array<object>} comments
 * @param {string|number|null} watermark
 */
export function commentsAfterWatermark(comments, watermark) {
  if (watermark === null || watermark === undefined || watermark === '') return [...comments];
  return comments.filter((comment) => compareIds(comment.id, watermark) > 0);
}

/**
 * 本轮扫描终点：本批评论中最大的 comment id（没有新评论时为 null）。
 * @param {Array<object>} comments
 */
export function scanEndpoint(comments) {
  let max = null;
  for (const comment of comments) {
    if (max === null || compareIds(comment.id, max) > 0) max = comment.id;
  }
  return max === null ? null : String(max);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function compareIds(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right)) return left === right ? 0 : left > right ? 1 : -1;
  const leftText = String(a);
  const rightText = String(b);
  return leftText === rightText ? 0 : leftText > rightText ? 1 : -1;
}

/**
 * 触发来源的稳定 identity 与可回查的 GitHub 信息。
 * @param {'issue_body'|'comment'} sourceType
 * @param {object} source
 */
export function triggerIdentity(sourceType, source) {
  if (sourceType === 'issue_body') {
    return { sourceType, sourceId: `issue-${source.number}-body`, author: source.user?.login ?? null };
  }
  return { sourceType, sourceId: String(source.id), author: source.user?.login ?? null };
}
