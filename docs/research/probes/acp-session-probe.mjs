// 最小探针：用 `acp` profile 的 ACP v1（stdio JSON-RPC）驱动一轮任务，
// 用于验证「进程退出后按保存的会话标识续接同一持久化会话」。
//
// 这是 Research 证据的最小复现件（见
// docs/research/2026-09-23-local-harness-cli-first-run-and-resume.md），
// 不是接单工具的运行代码，也不属于任何被接入项目的业务代码。
//
// 用法（PowerShell）：
//   $env:DSH_HOME = '<独立测试 home>'
//   $env:DSH_BIN  = '<dsh 启动器入口，即 @deepseek-ai/dsh 的 lib/bin.js>'
//   node acp-session-probe.mjs new    <绝对工作目录> <任务文本>
//   node acp-session-probe.mjs resume <绝对工作目录> <sessionId> <任务文本>
//
// 输出一行 JSON：mode、sessionId、stopReason、answer、updates。
// 失败时向 stderr 打印 JSON-RPC 错误并退出 1；超时退出 3。
// 探针只投递文本、只读回结果，不写业务文件；会话持久化在 $DSH_HOME 下。

import { spawn } from 'node:child_process';

const DSH_BIN = process.env.DSH_BIN;
const [mode, cwd, ...rest] = process.argv.slice(2);
if (!DSH_BIN || (mode !== 'new' && mode !== 'resume')) {
  console.error('usage: DSH_BIN=<dsh lib/bin.js> node acp-session-probe.mjs new|resume <cwd> [sessionId] <task>');
  process.exit(2);
}
const sessionId = mode === 'resume' ? rest.shift() : undefined;
const task = rest.join(' ');

const child = spawn(process.execPath, [DSH_BIN, '--profile', 'acp'], {
  cwd,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

let nextId = 1;
const pending = new Map();
let buffer = '';
const transcript = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== '') handle(line);
  }
});

function handle(line) {
  if (process.env.PROBE_DEBUG) console.error(`[probe] <- ${line.slice(0, 500)}`);
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.error(`[probe] non-JSON stdout line: ${line.slice(0, 200)}`);
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
    return;
  }
  if (message.method === 'session/update') {
    collectUpdate(message.params);
    return;
  }
  if (message.method === 'session/request_permission') {
    // 受信任的测试控制方：一次性批准，避免意外工具调用把探针挂住。
    send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'probe: unsupported request' } });
  }
}

function collectUpdate(params) {
  const update = params?.update;
  if (!update) return;
  const kind = update.sessionUpdate;
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const text = (update.content?.type === 'text' ? update.content.text : '') ?? '';
    if (text !== '') transcript.push({ kind, text });
  } else {
    transcript.push({ kind });
  }
}

function send(message) {
  if (process.env.PROBE_DEBUG) console.error(`[probe] -> ${JSON.stringify(message)}`);
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 120000);
const timer = setTimeout(() => {
  console.error(`[probe] timeout after ${timeoutMs}ms`);
  child.kill();
  process.exitCode = 3;
}, timeoutMs);

try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const summary = mode === 'new'
    ? await request('session/new', { cwd, mcpServers: [] })
    : await request('session/resume', { sessionId, cwd, mcpServers: [] });
  // session/new 会回显标识；session/resume 只返回配置项，因此续接时使用入参标识。
  const resolvedId = summary.sessionId ?? sessionId;
  const result = await request('session/prompt', {
    sessionId: resolvedId,
    prompt: [{ type: 'text', text: task }],
  });
  const answer = transcript
    .filter((entry) => entry.kind === 'agent_message_chunk')
    .map((entry) => entry.text)
    .join('');
  console.log(JSON.stringify({
    mode,
    sessionId: resolvedId,
    stopReason: result?.stopReason,
    answer,
    updates: transcript.map((entry) => entry.kind),
  }, null, 2));
  await request('session/close', { sessionId: resolvedId });
} catch (error) {
  console.error(`[probe] failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child.stdin.end();
  setTimeout(() => child.kill(), 500).unref();
}
