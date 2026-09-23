// Harness headless 调用与续接 runner（Issue #7 的实测交付件）。
//
// 以 scripts/headless-session/overlay.yml 作为本地 runner 挂到随附的 headless
// profile 上，替换该 bundle 里固定新建会话的 runner：
//
//   $env:DSH_BIN  = '<dsh 安装的 lib/bin.js>'
//   $env:DSH_TASK = '<本次任务文本>'
//   node $env:DSH_BIN --profile headless --patch scripts/headless-session/overlay.yml
//
// 与官方 headless runner 的差异只在会话身份：给 `DSH_SESSION_ID` 就按该标识续接
// 既有持久化会话，没给就新建一个并把标识写进结果，供下一次进程复用。
//
// 环境变量：
//   DSH_BIN           必填；dsh 安装入口，用于解析随安装提供的包
//   DSH_TASK          本次任务文本；由 overlay 注入 config，缺省视为用法错误
//   DSH_SESSION_ID    要续接的会话标识；缺省表示新建会话
//   DSH_RESULT_FILE   结果文件路径；缺省只打印到 stdout
//   DSH_DEBUG_RUNNER  非空时把运行细节写到 stderr
//
// stdout：一行 result JSON（sessionId、continueReason、status、text、cwd）。
// stderr：模型 reasoning（与官方 headless 一致）与 `dsh: <code>: <message>` 失败行。
// 退出码：0 表示本轮 turn 以 completed 结束；1 表示失败、中止或用法错误。

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 本文件位于仓库而非 profile 目录，裸包名无法从本文件解析；按 dsh 安装位置解析。
 * `DSH_BIN` 指向该安装的 `lib/bin.js`，其上一级目录即安装内的包目录。
 */
async function importFromInstallation(specifier) {
  const bin = process.env.DSH_BIN;
  const anchor = bin === undefined || bin === '' ? undefined : join(dirname(bin), 'package.json');
  if (anchor !== undefined) {
    try {
      return await import(pathToFileURL(createRequire(anchor).resolve(specifier)).href);
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  return import(specifier);
}

const { createUserMessage } = await importFromInstallation('@deepseek-ai/dsh-llm');

export const name = 'headless-session-runner';

export const inject = ['agentDefaultModel', 'agents', 'sessions'];

function debug(message) {
  if ((process.env.DSH_DEBUG_RUNNER ?? '') !== '') process.stderr.write(`dsh-session: ${message}\n`);
}

/** 只把 provider 上报的 reasoning 增量转发到 stderr，与官方 headless 输出约定一致。 */
function streamReasoning(ctx, agent) {
  let open = false;
  const close = () => {
    if (!open) return;
    process.stderr.write('\n');
    open = false;
  };
  const dispose = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return;
    if (frame.type !== 'chunk') {
      close();
      return;
    }
    const chunk = frame.chunk;
    if (chunk.type === 'reasoning-delta') {
      if (chunk.text === '') return;
      if (!open) {
        process.stderr.write('dsh: reasoning:\n');
        open = true;
      }
      process.stderr.write(chunk.text);
      return;
    }
    if (chunk.type === 'usage' || chunk.type === 'block-start') return;
    close();
  });
  return () => {
    dispose();
    close();
  };
}

/** 从本轮新写入的事件区间里取最后一条非空 assistant 文本与 turn 结局。 */
function summarize(session, firstSeq) {
  let started = false;
  let text = '';
  let status;
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const event = session.eventAt(seq);
    if (event === undefined) break;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (joined !== '') text = joined;
    }
    if (event.type === 'turn/end') status = event.data.reason;
  }
  return { text, status };
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit');
  if (exit === undefined) throw new Error('headless-session-runner: the launcher must provide ctx.appExit');
  run(ctx, config, exit).catch((error) => {
    process.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
}

async function run(ctx, config, exit) {
  if (typeof config.task !== 'string' || config.task.trim() === '') {
    throw new Error('DSH_TASK is required; refusing to start a turn without a task');
  }
  await ctx.get('loader')?.await();
  const agents = ctx.get('agents');
  const defaultModel = ctx.get('agentDefaultModel');
  const sessions = ctx.get('sessions');
  if (agents === undefined || defaultModel === undefined || sessions === undefined) {
    throw new Error('headless-session-runner: agents, agentDefaultModel and sessions must be mounted');
  }
  const selection = defaultModel.currentSelection();
  const requested = config.sessionId;
  const resuming = requested !== undefined && requested !== null && requested !== '';
  const sessionId = resuming ? requested : `session-${randomUUID()}`;

  let handle;
  let continueReason;
  if (resuming) {
    handle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
    });
    // 续接必须留在原工作目录：带错目录会让执行者在新目录里继续旧任务。
    const recorded = handle.agent.session.header?.cwd;
    if (recorded === undefined || resolve(recorded) !== resolve(process.cwd())) {
      await handle.dispose();
      throw new Error(
        `session ${sessionId} was recorded in ${recorded ?? '(unknown)'}, not ${process.cwd()}; `
        + 'resume it from that directory instead of starting elsewhere',
      );
    }
    continueReason = 'resumed';
    debug(`resumed ${sessionId} (cwd=${recorded})`);
  } else {
    handle = await agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
    });
    continueReason = 'created';
    debug(`created ${sessionId}`);
  }
  const agent = handle.agent;
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  const stopReasoning = streamReasoning(ctx, agent);
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: config.task }],
      source: { kind: 'user' },
    }));
    await agent.whenIdle();
  } finally {
    stopReasoning();
  }
  await sessions.flush(agent.session);
  const outcome = summarize(agent.session, firstSeq);
  const failed = outcome.status?.kind !== 'completed';
  if (outcome.status?.kind === 'error') {
    process.stderr.write(`dsh: ${outcome.status.error.code}: ${outcome.status.error.message}\n`);
  }
  const result = {
    sessionId,
    continueReason,
    status: outcome.status ?? null,
    text: outcome.text,
    cwd: process.cwd(),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (config.resultFile !== undefined && config.resultFile !== '') {
    writeFileSync(config.resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    debug(`result written to ${config.resultFile}`);
  }
  exit(failed ? 1 : 0);
}
