// 接单主流程：读取增量评论 → 授权与路由 → 任务绑定 → 启动／续接 Harness → 回写状态。
//
// 分工边界：本模块只做接单、路由、进程调用、绑定与必要反馈。它不分析业务需求、不裁决
// Finding、不代替维护者决定，也不重建提交与 Review 编排——那些由 Dev 在目标项目里按该
// 项目规则完成。

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { buildTaskPrompt, collectCommands, commandRef } from './commands.mjs';
import { HarnessError, runHarness } from './harness.mjs';
import {
  bindingProblems, createBinding, findCommand, loadState, recordCommand, saveState, statePath,
} from './state.mjs';
import { prepareWorkspace } from './workspace.mjs';

/**
 * 接单结果 → 回写 Issue 的评论正文。一条命令只回一条，不每分钟刷评论。
 *
 * 公开评论不带任何本机路径信息（连目录名也不带），只给执行机、会话标识与一个由目录派生的
 * 稳定标识 `workspaceRef`；本机可用它在本机状态/日志里对齐同一条任务。模型输出、完整日志
 * 与凭据一律留在本机，按 Current「不公开本机敏感路径」的要求处理。
 */
export function formatComment({ kind, binding, detail }) {
  const who = `接单执行机 \`${binding?.runnerId ?? '(unknown)'}\``;
  const where = binding === null || binding === undefined
    ? ''
    : `\n\n- 任务标识：\`${workspaceRef(binding.dir)}\`\n- 会话：\`${binding.sessionId ?? '(none)'}\``;
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
    case 'turn-failed':
      return `本次调用已结束，但回合没有正常完成，因此没有可判读的交付结果。\n\n${who}${where}${note}\n\n判定与后续由维护者／Dev 按目标项目规则处理；工作目录与绑定保留。`;
    case 'scope':
      return `本条未启动。${note}`;
    default:
      return `接单状态：${kind}${note}`;
  }
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * 工作目录派生的稳定公开标识：同一目录每次得到同一个值，但不泄露路径本身（目录名也可能
 * 是部署者的本机信息）。本机可用它在本机状态与日志里对齐任务。
 */
export function workspaceRef(dir) {
  if (typeof dir !== 'string' || dir === '') return '(unknown)';
  return `ws-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
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

  /**
   * 子进程输出落盘位置。`capture: 'pipe'` 时不需要，返回 undefined 让 exec 走管道。
   */
  function execFiles(runDir, label) {
    if (runtime.capture !== 'file') return undefined;
    return {
      stdoutFile: join(runDir, `${label}.stdout.log`),
      stderrFile: join(runDir, `${label}.stderr.log`),
    };
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
  async function planTask({ repository, issueNumber, entry, runDir }) {
    const problems = bindingProblems(entry.binding, repository, config.runnerId);
    if (entry.binding !== null && problems.length > 0) return { ok: false, reason: problems.join('；') };
    return prepareWorkspace({
      repository,
      issueNumber,
      exec,
      existing: entry.binding,
      capture: runtime.capture,
      files: execFiles(runDir, 'git'),
    });
  }

  async function execute({ repository, issue, command }) {
    const repo = repository.repo;
    const entry = entryFor(repo, issue.number);
    // 每轮调用的输出落在同一个 runDir：git、Harness 与本机错误原因都可回查。
    const runDir = newRunDir(repo, issue.number, command.id);
    const plan = await planTask({ repository, issueNumber: issue.number, entry, runDir });
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
        stdoutPath: join(runDir, 'harness.stdout.log'),
        stderrPath: join(runDir, 'harness.stderr.log'),
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
    if (!completed) {
      // CLI 执行失败／被中止也是调用结果的一部分：在 Issue 上留一条可读原因，避免停在「已接单」。
      await feedback({
        repo,
        issueNumber: issue.number,
        body: formatComment({
          kind: 'turn-failed',
          binding,
          detail: `退出码 ${outcome.exitCode}，回合状态 ${outcome.statusKind ?? '(unknown)'}${outcome.detail === '' ? '' : `；${outcome.detail}`}`,
        }),
      });
    }
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
    const { newestSeq, selected, ignored, edited } = collectCommands({
      comments,
      sinceSeq,
      isAuthorized: (login) => repository.allowedActors.includes(login),
      command: config.github.command,
    });

    // 认领与推进进度放在同一次落盘，中间不 await：进程在这个窗口被杀也不会出现
    // 「进度已过但没有认领记录」的静默丢命令。一条任务只接一条新命令，其余本轮回复未启动。
    const busy = [];
    let claimed = null;
    for (const comment of selected) {
      const existing = findCommand(entry, comment.id);
      if (existing !== null && existing.retryable !== true) {
        log(`跳过已处理命令 ${repository.repo}#${issue.number} comment=${comment.id} status=${existing.status}`);
        continue;
      }
      if (existing !== null) {
        // 上次停在准备阶段、Harness 从未启动：恢复时已回报不确定，本轮按同一条评论重试一次。
        log(`重试上次未真正开始的命令 ${repository.repo}#${issue.number} comment=${comment.id}`);
      }
      if (claimed !== null) {
        recordCommand(entry, { ...commandRef(comment), at: new Date().toISOString(), status: 'busy' });
        busy.push(comment);
        continue;
      }
      recordCommand(entry, { ...commandRef(comment), at: new Date().toISOString(), status: 'claimed', retryable: false });
      entry.inFlight = true;
      claimed = comment;
    }
    entry.seenSeq = newestSeq;
    save();

    for (const comment of edited) {
      log(`忽略被编辑过的评论 ${repository.repo}#${issue.number} comment=${comment.id}`);
      await feedback({
        repo: repository.repo,
        issueNumber: issue.number,
        body: formatComment({
          kind: 'scope',
          detail: `评论 ${comment.url ?? comment.id} 已被编辑；首版只接受新发布的独立命令评论，本条未启动。`,
        }),
      });
    }

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

    if (claimed !== null) {
      // 先执行被认领的命令：它对应「已接单」这条反馈，先于其余命令的「未启动」回复出现在 Issue 上。
      const ref = commandRef(claimed);
      const result = await execute({ repository, issue, command: ref });
      entry.inFlight = false;
      const record = findCommand(entry, claimed.id);
      if (record !== null) {
        record.status = result.kind;
        record.finishedAt = new Date().toISOString();
      }
      save();
    }

    for (const comment of busy) {
      await feedback({ repo: repository.repo, issueNumber: issue.number, body: formatComment({ kind: 'busy' }) });
    }

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
      if (issue.fromPullRequest === true) {
        // issues 接口也返回 PR；PR 不是接单入口。
        log(`跳过 ${repository.repo}#${issue.number}：这是 Pull Request，不是 Issue`);
        continue;
      }
      // 只接「恰好一个」执行机标签的任务：多标签意味着多台电脑都可能接，会出现第二个写入者。
      const routeLabels = issue.labels.filter((label) => label.startsWith('runner:'));
      if (routeLabels.length !== 1 || routeLabels[0] !== repository.label) {
        log(`跳过 ${repository.repo}#${issue.number}：执行机标签 [${routeLabels.join(',')}] 不是唯一的 ${repository.label}`);
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

  /**
   * 正常重启：把上一轮「已认领未结束」的命令如实报为结果不确定。
   *
   * 有绑定说明上次调用真的开始过（或至少已准备好目录）：不重跑，等新指令按原目录续接。
   * 没有绑定说明上次停在准备阶段、Harness 从未启动，没有任何开发工作发生过：允许受理时重试
   * 同一条评论——否则这条已授权的命令会因为「已认领」而被永久跳过。
   */
  async function recover() {
    for (const [repo, bucket] of Object.entries(state.repositories)) {
      for (const [number, entry] of Object.entries(bucket)) {
        const claimed = (entry.commands ?? []).filter((item) => item.status === 'claimed');
        if (claimed.length === 0) continue;
        const binding = entry.binding ?? null;
        const retryable = binding === null;
        for (const command of claimed) {
          command.status = 'uncertain';
          command.finishedAt = new Date().toISOString();
          command.retryable = retryable;
        }
        entry.inFlight = false; // 残留标记必须清掉，否则下一条命令会被当成忙碌。
        if (retryable) {
          // 进度回退到该评论之前，让它在下一轮检查里作为「新命令」被重新受理一次；
          // 受理时只多认领这一条，其它已处理评论仍由状态里的记录挡住。
          entry.seenSeq = Math.max(0, claimed[0].id - 1);
        }
        save();
        for (const command of claimed) {
          await feedback({
            repo,
            issueNumber: Number(number),
            body: formatComment({
              kind: 'uncertain',
              binding,
              detail: retryable
                ? `评论 ${command.id} 已登记但上次停在准备工作目录阶段、没有真正开始调用；本条会在下一轮检查时重试一次。`
                : `上一次调用（评论 ${command.id}）没有留下可判读的结束记录，程序在恢复时发现中断。绑定与工作目录保留，请核对后另发一条新指令。`,
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
