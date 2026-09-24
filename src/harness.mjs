// Harness headless 调用：直接使用官方 --json / --session-id Contract。
//
// 任务正文走 stdin，不进入 shell 或命令行参数；首次调用从 JSONL 的 session 事件记录
// 真实 sessionId，续接时把已保存的标识交给官方 --session-id。模型 Key 仍由 Harness
// 按受支持方式自行加载，本工具不读取、不打印、不保存 Key。

import { writeFileSync } from 'node:fs';

/** 调用失败：进程没起来、超时等，与「Harness 已运行但回合失败」分开表述。 */
export class HarnessError extends Error {
  constructor(message, { detail } = {}) {
    super(message);
    this.name = 'HarnessError';
    this.detail = detail ?? null;
  }
}

function lastOf(events, predicate) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (predicate(events[index])) return events[index];
  }
  return null;
}

/**
 * 判读官方 headless --json 的 newline-delimited JSON。
 *
 * stdout 可能含模型正文、thinking 与 tool result，因此只解析必要控制事件，不把原始 stdout
 * 拼进公开 reason。若流中已有 session 事件但后续损坏，仍保留 sessionId 供绑定，避免下一轮
 * 因丢失身份又创建一个新会话；同时把完成状态降为不可判读。
 */
export function readResult({ exitCode, stdout, stderr, requestedSessionId = null }) {
  const events = [];
  const parseErrors = [];
  const lines = String(stdout ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === '') continue;
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) events.push(value);
      else parseErrors.push(`第 ${index + 1} 行不是 JSON object`);
    } catch (error) {
      parseErrors.push(`第 ${index + 1} 行不是合法 JSON：${error.message}`);
    }
  }

  const sessionEvent = events.find((event) => event.type === 'session' && typeof event.sessionId === 'string');
  const sessionId = typeof sessionEvent?.sessionId === 'string' && sessionEvent.sessionId !== ''
    ? sessionEvent.sessionId
    : null;
  const turnEnd = lastOf(events, (event) => event.type === 'status' && event.phase === 'turn_end');
  const finalEvent = lastOf(events, (event) => event.type === 'final');
  const directError = lastOf(events, (event) => event.type === 'error');
  const turnReason = turnEnd?.reason ?? null;
  const turnError = turnReason?.kind === 'error' ? turnReason.error : null;

  const integrity = [...parseErrors];
  if (requestedSessionId !== null && sessionId !== null && sessionId !== requestedSessionId) {
    integrity.push(`Harness 返回的 sessionId 与请求不一致（requested=${requestedSessionId}, actual=${sessionId}）`);
  }
  if (exitCode === 0 && sessionId === null) integrity.push('退出码为 0，但 JSONL 缺少 session 事件');
  if (exitCode === 0 && turnEnd === null) integrity.push('退出码为 0，但 JSONL 缺少 turn_end 事件');
  if (exitCode === 0 && finalEvent === null) integrity.push('退出码为 0，但 JSONL 缺少 final 事件');

  let statusKind = null;
  if (integrity.length === 0) {
    if (typeof turnReason?.kind === 'string') statusKind = turnReason.kind;
    else if (directError !== null) statusKind = 'error';
  }

  const errorCode = typeof turnError?.code === 'string' ? turnError.code : null;
  const errorMessage = typeof turnError?.message === 'string'
    ? turnError.message
    : (typeof directError?.message === 'string' ? directError.message : '');
  const publicReason = [
    errorCode === null ? '' : `错误码 ${errorCode}`,
    errorMessage,
    ...integrity,
    `退出码 ${exitCode}`,
  ].filter((item) => item !== '').join('；');
  const localDetail = [
    ...integrity,
    errorMessage,
    String(stderr ?? '').trim().slice(0, 300),
  ].find((item) => item !== '') ?? '';

  return {
    exitCode,
    sessionId,
    continueReason: requestedSessionId === null ? 'created' : 'resumed',
    statusKind,
    errorCode,
    reason: publicReason,
    detail: localDetail,
  };
}

/**
 * @param {object} options
 * @param {object} options.harness 配置里的 harness 段
 * @param {(options: object) => Promise<object>} options.exec 子进程调用实现（可注入替身）
 * @param {string} options.cwd 任务工作目录
 * @param {string} options.task 交给 Dev 的启动消息
 * @param {string|null} options.sessionId 已保存的会话标识；null 表示首次新建
 * @param {string} options.resultPath 派生控制摘要的本机路径（不含模型正文）
 * @param {string} options.stdoutPath 官方 JSONL 原始日志
 * @param {string} options.stderrPath CLI 本机错误日志
 * @param {string} [options.capture] 传给 exec 的输出捕获方式
 * @param {Record<string, string|undefined>} [options.env] 追加/覆盖的子进程环境变量
 */
export async function runHarness({
  harness, exec, cwd, task, sessionId, resultPath, stdoutPath, stderrPath, capture = 'file', env: extraEnv = {},
}) {
  const env = { ...process.env, ...extraEnv };
  if (harness.home !== undefined) env.DSH_HOME = harness.home;

  const args = [harness.bin, '--profile', harness.profile, '--json'];
  if (sessionId !== null && sessionId !== undefined) args.push('--session-id', sessionId);

  let result;
  try {
    result = await exec({
      command: harness.node,
      args,
      cwd,
      env,
      stdin: task,
      timeoutMs: harness.timeoutMs,
      capture,
      stdoutFile: stdoutPath,
      stderrFile: stderrPath,
    });
  } catch (error) {
    throw new HarnessError(`Harness 调用失败：${error.message}`, { detail: error.stderr ?? null });
  }

  let outcome = readResult({
    exitCode: result.exitCode,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    requestedSessionId: sessionId ?? null,
  });
  try {
    writeFileSync(resultPath, `${JSON.stringify({ ...outcome, cwd }, null, 2)}\n`, 'utf8');
  } catch (error) {
    // Harness 已经实际运行；此处不能因摘要落盘失败而丢掉刚取得的 sessionId，否则下轮可能误建新会话。
    const note = `派生结果文件写入失败：${error.message}`;
    outcome = { ...outcome, detail: outcome.detail === '' ? note : `${outcome.detail}；${note}` };
  }
  return { ...outcome, resultPath, stdoutPath, stderrPath };
}
