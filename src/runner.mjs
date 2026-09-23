// 接单主流程：读取增量评论 → 授权与路由 → 任务绑定 → 启动／续接 Harness → 回写状态。
//
// 分工边界：本模块只做接单、路由、进程调用、绑定与必要反馈。它不分析业务需求、不裁决
// Finding、不代替维护者决定，也不重建提交与 Review 编排——那些由 Dev 在目标项目里按该
// 项目规则完成。

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { buildTaskPrompt, collectCommands, commandRef } from './commands.mjs';
import { HarnessError, runHarness } from './harness.mjs';
import {
  bindingProblems, createBinding, findCommand, loadState, recordCommand, saveState, statePath,
} from './state.mjs';
import { prepareWorkspace } from './workspace.mjs';

/** 接单结果 → 回写 Issue 的评论正文。一条命令只回一条，不每分钟刷评论。 */
export function formatComment({ kind, binding, detail }) {
  const who = `接单执行机 \`${binding?.runnerId ?? '(unknown)'}\``;
  const where = binding === null || binding === undefined
    ? ''
    : `\n\n- 工作目录：\`${binding.dir}\`\n- 会话：\`${binding.sessionId ?? '(none)'}\``;
  const note = detail === undefined || detail === null || detail === '' ? '' : `\n\n原因：${detail}`;
  switch (kind) {
    case 'created':
      return `已接单：新建 Harness 会话并按该 Issue 开工。\n\n${who}，Dev 在目标项目会话中工作；实际执行与验收结果以该会话的报告为准。${where}${note}`;
    case 'resumed':
      return `已接单：在该任务既有工作目录续接原 Harness 会话，未新开会话。\n\n${who}；Dev 自报完成仍需业务验收。${where}${note}`;
    case 'busy':
      return `执行中，本条未启动；结束后重新发指令。\n\n${who} 上该任务已有一次调用在进行，本轮不叠加第二个写入者。`;
    case 'uncertain':
      return `上一次调用结果不确定。\n\n${who}${where}${note}\n\n不静默新建会话，也不盲目重跑；请核对后另发一条新指令。`;
    case 'failed':
      return `接单后调用失败，本条没有可判读的完成结果。\n\n${who}${where}${note}\n\n工作目录与绑定保留。`;
    case 'scope':
      return `本条未启动。${note}`;
    default:
      return `接单状态：${kind}${note}`;
  }
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** 只保留最近若干轮调用日志，避免本机日志无限增长。 */
export function pruneRunLogs(dir, keep) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((item) => item.isDirectory());
  } catch {
    return;
  }
  if (entries.length <= keep) return;
  const sorted = entries.sort((left, right) => right.name.localeCompare(left.name));
  for (const stale of sorted.slice(keep)) rmSync(join(dir, stale.name), { recursive: true, force: true });
}

/**
 * 会话标识是否在本机持久化目录里存在。只用于「上次调用在取得标识前中断」时判断能否按
 * 原绑定续接；真正的目录校验由 headless runner 自己完成。
 */
export function sessionRecordedLocally(dshHome, sessionId) {
  const root = join(dshHome, 'sessions');
  if (!existsSync(root)) return false;
  for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    const record = join(root, bucket.name, sessionId, 'session.v3.jsonl.zstd');
    if (existsSync(record)) return true;
  }
  return false;
}

export function createRunner({ config, gh, exec, log = () => {}, env = {} }) {
  const runtime = config.runtime;
  const stateFile = statePath(runtime.stateDir);
  const state = loadState(stateFile);

  function save() {
    saveState(stateFile, state);
  }

  function entryFor(repo, issueNumber) {
    const bucket = (state.repositories[repo] ??= {});
    return (bucket[String(issueNumber)] ??= { seenSeq: 0, commands: [], binding: null, lastRun: null });
  }

  function taskLogDir(repo, issueNumber) {
    return join(runtime.stateDir, 'logs', `${repo.replace('/', '-')}-issue-${issueNumber}`);
  }

  function tempPath(name) {
    const dir = join(runtime.stateDir, 'tmp');
    mkdirSync(dir, { recursive: true });
    return join(dir, name);
  }

  function newRunDir(repo, issueNumber, commandId) {
    const dir = taskLogDir(repo, issueNumber);
    mkdirSync(dir, { recursive: true });
    const runDir = join(dir, `${timestampSlug()}-${commandId}`);
    mkdirSync(runDir, { recursive: true });
    return runDir;
  }

  async function feedback({ repo, issueNumber, body }) {
    try {
      const created = await gh.createComment({ repo, issueNumber, body });
      log(`反馈已回写 ${repo}#${issueNumber}${created.url === null ? '' : ` ${created.url}`}`);
      return created;
    } catch (error) {
      // 回写失败只记录：同一次开发任务不因为反馈失败而自动再执行。
      log(`回写反馈失败 ${repo}#${issueNumber}：${error.message}`);
      return null;
    }
  }

  function baseline(entry, comments) {
    if (typeof entry.seenSeq !== 'number' || entry.seenSeq === 0) {
      entry.seenSeq = comments.reduce((max, item) => Math.max(max, item.id), 0);
      save();
    }
    return entry.seenSeq;
  }

  /**
   * 启动前的绑定核对与工作目录准备。绑定存在时沿用原目录（包括上次调用在取得会话标识
   * 前中断的情况），不重新准备，避免覆盖任务未提交的工作。
   */
  async function planTask({ repository, issueNumber, entry }) {
    const problems = bindingProblems(entry.binding, repository, config.runnerId);
    if (entry.binding !== null && problems.length > 0) return { ok: false, reason: problems.join('；') };
    return prepareWorkspace({
      repository,
      issueNumber,
      exec,
      existing: entry.binding,
      tempPath,
    });
  }

  async function execute({ repository, issue, command }) {
    const repo = repository.repo;
    const entry = entryFor(repo, issue.number);
    const plan = await planTask({ repository, issueNumber: issue.number, entry });
    if (!plan.ok) {
      log(`未启动 ${repo}#${issue.number}：${plan.reason}`);
      await feedback({ repo, issueNumber: issue.number, body: formatComment({ kind: 'scope', detail: plan.reason }) });
      return { kind: 'scope', detail: plan.reason };
    }

    // 上次调用在取得会话标识前中断：绑定与目录保留，本轮在同一目录新建会话并说明原因。
    const interruptedBeforeSession = entry.binding !== null && entry.binding.sessionId === null;
    const sessionId = interruptedBeforeSession ? null : (entry.binding?.sessionId ?? null);
    const binding = createBinding({
      runnerId: config.runnerId,
      dir: plan.dir,
      sessionId,
      branch: plan.branch ?? entry.binding?.branch ?? null,
      source: plan.source,
      worktreeCreated: plan.worktreeCreated,
    });
    entry.binding = binding;
    const detail = interruptedBeforeSession
      ? '上一次调用在取得会话标识前中断；本轮在同一工作目录新建会话。'
      : undefined;
    save();

    const prompt = buildTaskPrompt({
      repo,
      issueNumber: issue.number,
      issueUrl: issue.url,
      command,
      runnerId: config.runnerId,
    });
    await feedback({
      repo,
      issueNumber: issue.number,
      body: formatComment({ kind: sessionId === null ? 'created' : 'resumed', binding, detail }),
    });

    const runDir = newRunDir(repo, issue.number, command.id);
    let outcome;
    try {
      outcome = await runHarness({
        harness: config.harness,
        exec,
        env,
        cwd: plan.dir,
        task: prompt,
        sessionId,
        resultPath: join(runDir, 'result.json'),
        stdoutPath: join(runDir, 'stdout.log'),
        stderrPath: join(runDir, 'stderr.log'),
        capture: runtime.capture,
      });
    } catch (error) {
      const message = error instanceof HarnessError ? error.message : String(error?.message ?? error);
      log(`调用失败 ${repo}#${issue.number}：${message}`);
      entry.lastRun = { at: new Date().toISOString(), kind: 'failed', detail: message, dir: plan.dir, runDir };
      save();
      await feedback({ repo, issueNumber: issue.number, body: formatComment({ kind: 'failed', binding, detail: message }) });
      return { kind: 'failed', detail: message };
    }

    if (outcome.sessionId !== null && outcome.sessionId !== sessionId) binding.sessionId = outcome.sessionId;
    const completed = outcome.exitCode === 0 && outcome.statusKind === 'completed';
    entry.lastRun = {
      at: new Date().toISOString(),
      kind: completed ? 'completed' : 'turn-failed',
      exitCode: outcome.exitCode,
      statusKind: outcome.statusKind,
      detail: outcome.detail,
      dir: plan.dir,
      runDir,
    };
    save();
    pruneRunLogs(taskLogDir(repo, issue.number), runtime.keepRunLogs);
    log(`${repo}#${issue.number} 回合结束 exit=${outcome.exitCode} status=${outcome.statusKind ?? '(none)'} session=${binding.sessionId ?? '(none)'}`);
    // 回合结束不等于业务完成：业务结论与待决事项由 Dev 按目标项目规则报告。
    return {
      kind: completed ? 'completed' : 'turn-failed',
      detail: outcome.detail,
      sessionId: binding.sessionId,
      dir: plan.dir,
    };
  }

  async function handleComments({ repository, issue, comments }) {
    const entry = entryFor(repository.repo, issue.number);
    const sinceSeq = baseline(entry, comments);
    const { newestSeq, selected, ignored } = collectCommands({
      comments,
      sinceSeq,
      isAuthorized: (login) => repository.allowedActors.includes(login),
      command: config.github.command,
    });
    // 进度先落盘：无论后面是否启动，这批评论都不会被下一轮重新当成新命令。
    entry.seenSeq = newestSeq;
    save();

    for (const comment of ignored) {
      log(`忽略未授权命令 ${repository.repo}#${issue.number} comment=${comment.id} author=${comment.author}`);
      await feedback({
        repo: repository.repo,
        issueNumber: issue.number,
        body: formatComment({
          kind: 'scope',
          detail: `评论 ${comment.url ?? comment.id} 的作者 @${comment.author} 不在该仓库的 allowedActors 内。`,
        }),
      });
    }

    for (const comment of selected) {
      const ref = commandRef(comment);
      const existing = findCommand(entry, comment.id);
      if (existing !== null) {
        log(`跳过已处理命令 ${repository.repo}#${issue.number} comment=${comment.id} status=${existing.status}`);
        continue;
      }
      // 一条任务只能有一个写入者：本轮已有调用在跑（或刚跑完）时，其余新命令明确回复未启动。
      if (entry.inFlight === true || entry.ranThisCycle === true) {
        recordCommand(entry, { ...ref, at: new Date().toISOString(), status: 'busy' });
        save();
        await feedback({ repo: repository.repo, issueNumber: issue.number, body: formatComment({ kind: 'busy' }) });
        continue;
      }
      recordCommand(entry, { ...ref, at: new Date().toISOString(), status: 'claimed' });
      entry.inFlight = true;
      save();
      const result = await execute({ repository, issue, command: ref });
      entry.inFlight = false;
      entry.ranThisCycle = true;
      const record = findCommand(entry, comment.id);
      if (record !== null) {
        record.status = result.kind;
        record.finishedAt = new Date().toISOString();
      }
      save();
    }
    entry.ranThisCycle = false;
    return entry;
  }

  async function runRepository(repository) {
    let issues;
    try {
      issues = await gh.listOpenIssues({ repo: repository.repo, label: repository.label });
    } catch (error) {
      log(`读取 Issue 失败 ${repository.repo}：${error.message}${error.rateLimited === true ? '（疑似限流，下轮重试）' : ''}`);
      return;
    }
    for (const issue of issues) {
      if (!issue.labels.includes(repository.label)) {
        // 服务端已按标签过滤；本地再核对一次，多标签或标签被改动的任务不启动。
        log(`跳过 ${repository.repo}#${issue.number}：标签 [${issue.labels.join(',')}] 不含 ${repository.label}`);
        continue;
      }
      let comments;
      try {
        comments = await gh.listComments({ repo: repository.repo, issueNumber: issue.number });
      } catch (error) {
        log(`读取评论失败 ${repository.repo}#${issue.number}：${error.message}`);
        continue;
      }
      await handleComments({ repository, issue: { ...issue, comments }, comments });
    }
  }

  /** 正常重启：上一轮「已认领未结束」的命令如实报为结果不确定，不自动重跑。 */
  async function recover() {
    for (const [repo, bucket] of Object.entries(state.repositories)) {
      for (const [number, entry] of Object.entries(bucket)) {
        const claimed = (entry.commands ?? []).filter((item) => item.status === 'claimed');
        if (claimed.length === 0) continue;
        const binding = entry.binding ?? null;
        // inFlight 表示上次调用在进程存活期间进行过；残留标记必须清掉，否则下一次会被当忙碌。
        const interrupted = entry.inFlight === true;
        entry.inFlight = false;
        for (const command of claimed) {
          command.status = 'uncertain';
          command.finishedAt = new Date().toISOString();
          save();
          await feedback({
            repo,
            issueNumber: Number(number),
            body: formatComment({
              kind: 'uncertain',
              binding,
              detail: interrupted
                ? `上一次调用（评论 ${command.id}）没有留下可判读的结束记录，程序在恢复时发现中断。绑定与工作目录保留，下一条新指令会按原目录继续。`
                : `命令（评论 ${command.id}）已被登记但调用没有开始，程序在恢复时发现中断；本条不会重跑。`,
            }),
          });
        }
      }
    }
  }

  async function cycle() {
    for (const repository of config.repositories) {
      if (repository.machineId !== config.runnerId) {
        log(`配置跳过 ${repository.repo}：machineId=${repository.machineId}，本机 ${config.runnerId}`);
        continue;
      }
      await runRepository(repository);
    }
  }

  return { cycle, recover, execute, handleComments, stateFile, state };
}
