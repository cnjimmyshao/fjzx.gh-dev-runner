// Harness headless 调用：按任务绑定启动或续接一个会话，并判读结果。
//
// 调用方式沿用已实测的 `scripts/headless-session/`：启动器 + headless profile +
// overlay，任务文本与续接标识通过环境变量传入，不拼成 shell 命令。模型 Key 由 Harness
// 按其受支持的方式自行加载（继承环境、`$DSH_HOME/.credentials.yaml`、`.env`），本工具
// 不读取、不打印、不保存 Key。

import { existsSync, readFileSync } from 'node:fs';

/** 调用失败：进程没起来、超时、结果不可判读等，与「回合失败」分开表述。 */
export class HarnessError extends Error {
  constructor(message, { detail } = {}) {
    super(message);
    this.name = 'HarnessError';
    this.detail = detail ?? null;
  }
}

/** 退出码 0 只代表本轮 turn 以 completed 结束；业务完成仍由 Dev 自己报告。 */
export function readResult({ resultPath, exitCode, stdout, stderr }) {
  let parsed = null;
  let parseError = null;
  if (existsSync(resultPath)) {
    try {
      parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
    } catch (error) {
      parseError = `结果文件不是合法 JSON：${error.message}`;
    }
  }
  const summary = parsed === null
    ? (stdout.trim().split(/\r?\n/).find((line) => line.trim() !== '') ?? '')
    : '';
  const status = parsed?.status ?? null;
  const errorMessage = status?.error?.message ?? (parseError ?? '');
  return {
    exitCode,
    sessionId: typeof parsed?.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : null,
    continueReason: typeof parsed?.continueReason === 'string' ? parsed.continueReason : null,
    statusKind: typeof status?.kind === 'string' ? status.kind : null,
    errorCode: status?.error?.code ?? null,
    detail: errorMessage === '' ? (summary === '' ? stderr.trim().slice(0, 300) : summary.slice(0, 300)) : errorMessage,
  };
}

/**
 * @param {object} options
 * @param {object} options.harness 配置里的 harness 段
 * @param {(options: object) => Promise<object>} options.exec 子进程调用实现（可注入替身）
 * @param {string} options.cwd 任务工作目录
 * @param {string} options.task 交给 Dev 的启动消息
 * @param {string|null} options.sessionId 已保存的会话标识；null 表示首次新建
 * @param {string} options.resultPath 结果 JSON 落盘路径
 * @param {string} options.stdoutPath CLI 本机日志
 * @param {string} options.stderrPath CLI 本机错误日志
 * @param {string} [options.capture]
 */
export async function runHarness({
  harness, exec, cwd, task, sessionId, resultPath, stdoutPath, stderrPath, capture = 'file', env: extraEnv = {},
}) {
  const env = {
    ...process.env,
    ...extraEnv,
    DSH_TASK: task,
    DSH_RESULT_FILE: resultPath,
  };
  // 只在续接时给会话标识：给了空值会被 overlay 当成「没有标识」而新建会话。
  if (sessionId === null || sessionId === undefined) delete env.DSH_SESSION_ID;
  else env.DSH_SESSION_ID = sessionId;
  if (harness.home !== undefined) env.DSH_HOME = harness.home;
  // 本地 runner 按 DSH_BIN 解析随安装提供的包，必须与实际启动的安装一致。
  env.DSH_BIN = harness.bin;

  const args = [harness.bin, '--profile', harness.profile, '--patch', harness.patch];
  let result;
  try {
    result = await exec({
      command: harness.node,
      args,
      cwd,
      env,
      timeoutMs: harness.timeoutMs,
      capture,
      stdoutFile: stdoutPath,
      stderrFile: stderrPath,
    });
  } catch (error) {
    throw new HarnessError(`Harness 调用失败：${error.message}`, { detail: error.stderr ?? null });
  }
  const outcome = readResult({
    resultPath,
    exitCode: result.exitCode,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  });
  return { ...outcome, resultPath, stdoutPath, stderrPath };
}
