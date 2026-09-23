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
    : `\n\n- 任务标识：\`${binding.workspaceRef ?? workspaceRef(binding.dir)}\`\n- 会话：\`${binding.sessionId ?? '(none)'}\``;
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
    // seenSeq: null 表示「还没扫描过这个 Issue」；0 是合法的已初始化值（当时没有任何评论）。
    return (bucket[String(issueNumber)] ??= { seenSeq: null, commands: [], binding: null, lastRun: null });
  }

  function taskLogDir(repo, issueNumber) {
    return join(runtime.stateDir, 'logs', `${repo.replace('/', '-')}-issue-${issueNumber}`);
  }

  /**
   * 工作目录归属核对：一个工作目录只能服务一个任务。
   *
   * `sourceDir` 模式下每个 Issue 有独立的 git worktree，天然隔离；但只配了 `repoDir` 时所有 Issue
   * 都会落到同一个目录——那等于两个任务在同一份检出上并行开发，会互相覆盖未提交的工作。这里按绑定
   * 记录拦住这种情况并如实报告，而不是等到现场才发现。
   */
  function workspaceConflict(repository, issueNumber) {
    const bucket = state.repositories[repository.repo] ?? {};
    for (const [otherNumber, other] of Object.entries(bucket)) {
      if (Number(otherNumber) === Number(issueNumber)) continue;
      const dir = other?.binding?.dir;
      if (dir === undefined || dir === null) continue;
      if (repository.sourceDir === undefined && dir === repository.repoDir) {
        return `工作目录 ${dir} 已被同一仓库的 Issue #${otherNumber} 占用。只配 repoDir 时该仓库的多个任务会共用同一目录，`
          + '请在配置里改用 sourceDir（每个任务一个独立 git worktree）或为任务分别准备目录。';
      }
    }
    return null;
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

  /**
   * 首次接入的进度基线：把当时已存在的评论登记为已看过，不重放历史命令。
   *
   * `seenSeq: null` 表示「该 Issue 还没被扫描过」；扫描过后即使是 `0`（尚无评论）也算已初始化。
   * 早先版本用 `0` 兼作「未初始化」，导致一个尚无评论的 Issue 在首条评论恰好是命令时，把这
   * 条命令当成基线吞掉——那是最常见的接入顺序（建 Issue → 发命令）。
   */
  function baseline(entry, comments) {
    if (entry.seenSeq === null || entry.seenSeq === undefined) {
      entry.seenSeq = comments.reduce((max, item) => Math.max(max, item.id), 0);
      save();
    }
    return entry.seenSeq ?? 0;
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
    const conflict = workspaceConflict(repository, issue.number);
    if (conflict !== null) {
      log(`未启动 ${repo}#${issue.number}：${conflict}`);
      await feedback({ repo, issueNumber: issue.number, body: formatComment({ kind: 'scope', detail: conflict }) });
      return { kind: 'scope', detail: conflict };
    }
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
    // 公开评论里用的稳定任务标识一并落盘：本机可以直接用它在 state/日志里对齐任务，
    // 不必自己重算哈希（也算给公开评论与本地记录留了一条可核对的线索）。
    binding.workspaceRef = workspaceRef(plan.dir);
    entry.binding = binding;
    const detail = interruptedBeforeSession
      ? '上一次调用在取得会话标识前中断；本轮在同一工作目录新建会话。'
      : undefined;
    save();

    const prompt = buildTaskPrompt({
      repo,
      issueNumber: issue.number,
      issueUrl: issue.url,
      command: config.github.command,
      trigger: command,
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
      // 调用失败的轮次同样留下 runDir，也要按保留上限清理，否则反复失败的调用会一直堆积。
      pruneRunLogs(taskLogDir(repo, issue.number), runtime.keepRunLogs);
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
    log(`${repo}#${issue.number} 回合结束 exit=${outcome.exitCode} status=${outcome.statusKind ?? '(none)'} session=${binding.sessionId ?? '(none)'}${outcome.detail === '' ? '' : ` detail=${outcome.detail}`}`);
    if (!completed) {
      // CLI 执行失败／被中止也是调用结果的一部分：在 Issue 上留一条可读原因，避免停在「已接单」。
      // 公开只用结构化原因（错误码/消息、退出码、状态），stdout/stderr 摘要留在本机日志。
      await feedback({
        repo,
        issueNumber: issue.number,
        body: formatComment({
          kind: 'turn-failed',
          binding,
          detail: `回合状态 ${outcome.statusKind ?? '(unknown)'}；${outcome.reason}`,
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
    const migrated = migrateLegacyProgress(entry);
    if (migrated > 0) {
      log(`状态来自旧版本：${repository.repo}#${issue.number} 有 ${migrated} 条命令曾被当成基线吞掉，已回退进度以便重新受理`);
    }
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
        // 同一批里已经有命令被认领：本条回复未启动。已经回复过的记录（进度回退时会被重新选中）
        // 不再重复回复，但记录要保持原状。
        const existingBusy = findCommand(entry, comment.id);
        if (existingBusy === null) {
          recordCommand(entry, { ...commandRef(comment), at: new Date().toISOString(), status: 'busy' });
        }
        if (existingBusy === null || existingBusy.feedbackSent !== true) busy.push(comment);
        continue;
      }
      recordCommand(entry, { ...commandRef(comment), at: new Date().toISOString(), status: 'claimed', retryable: false });
      entry.inFlight = true;
      claimed = comment;
    }
    entry.seenSeq = newestSeq;
    save();

    // 「本条未启动」的回复必须在调用开始之前发出：调用可能持续到 harness.timeoutMs，期间进程
    // 被杀会让这些回复永久丢失，而它们的记录已经落盘、恢复后不会被当成新命令而补发。
    for (const comment of busy) {
      await feedback({
        repo: repository.repo,
        issueNumber: issue.number,
        body: formatComment({ kind: 'busy', binding: { runnerId: config.runnerId } }),
      });
      // 记下「已经回复过未启动」：进度回退后这些评论会被重新选中，不能重复刷同一条回复。
      recordCommand(entry, { ...commandRef(comment), status: 'busy', feedbackSent: true });
    }
    if (busy.length > 0) save();

    for (const comment of edited) {
      await scopeFeedback({
        entry,
        repo: repository.repo,
        issueNumber: issue.number,
        comment,
        detail: `评论 ${comment.url ?? comment.id} 已被编辑；首版只接受新发布的独立命令评论，本条未启动。`,
      });
    }

    for (const comment of ignored) {
      log(`忽略未授权命令 ${repository.repo}#${issue.number} comment=${comment.id} author=${comment.author}`);
      await scopeFeedback({
        entry,
        repo: repository.repo,
        issueNumber: issue.number,
        comment,
        detail: `评论 ${comment.url ?? comment.id} 的作者 @${comment.author} 不在该仓库的 allowedActors 内。`,
      });
    }

    if (claimed !== null) {
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

    return entry;
  }

  /**
   * 「本条未启动」类回复只发一次：恢复时若回退了进度水位，这一批评论可能被重新选中，靠记录上的
   * feedbackSent 标记避免同一条评论被重复回复。
   */
  async function scopeFeedback({ entry, repo, issueNumber, comment, detail }) {
    const record = findCommand(entry, comment.id);
    if (record !== null && record.feedbackSent === true) return;
    recordCommand(entry, { ...commandRef(comment), at: new Date().toISOString(), status: 'scope', feedbackSent: true });
    save();
    log(`未启动 ${repo}#${issueNumber} comment=${comment.id}`);
    await feedback({ repo, issueNumber, body: formatComment({ kind: 'scope', detail }) });
  }

  async function runRepository(repository) {
    let issues;
    try {
      issues = await gh.listOpenIssues({ repo: repository.repo, label: repository.label });
    } catch (error) {
      log(`读取 Issue 失败 ${repository.repo}：${error.message}${error.rateLimited === true ? '（疑似限流，下轮重试）' : ''}`);
      return false;
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
    return true;
  }

  /**
   * 旧版本状态里「被当成基线吞掉」的命令。
   *
   * 旧版本用 `0` 兼作「该 Issue 还没被扫描过」，于是「尚无评论的 Issue」其首条命令会被当成基线
   * 吞掉，留下 `seenSeq: 0` + 一条 `claimed` 记录、且**从未创建过会话**的卡住状态。新版本用
   * `null` 表示未扫描、`0` 是合法值，因此读到 `seenSeq: 0` 的 claimed 记录即可判定为旧语义的
   * 受害者：进度退回该命令之前并标记可重试，让它在受理时被重新认领一次（不新建第二个写入者）。
   */
  function migrateLegacyProgress(entry) {
    if (entry.seenSeq !== 0) return 0;
    const claimed = (entry.commands ?? []).filter((item) => item.status === 'claimed');
    if (claimed.length === 0) return 0;
    entry.seenSeq = Math.max(0, claimed[0].id - 1);
    for (const command of claimed) {
      command.retryable = true;
      command.legacyStuck = true;
    }
    save();
    return claimed.length;
  }

  /**
   * 正常重启：把上一轮「已认领未结束」的命令如实报为结果不确定。
   *
   * 有绑定说明上次调用真的开始过（或至少已准备好目录）：不重跑，等新指令按原目录续接。
   * 没有绑定说明上次停在准备阶段、Harness 从未启动，没有任何开发工作发生过：允许受理时重试
   * 同一条评论——否则这条已授权的命令会因为「已认领」而被永久跳过。
   */
  async function recover() {
    // 只处理当前配置里仍然接入、且分配给本机的仓库：仓库被移除或任务已迁到别的机器后，
    // 旧状态里的 claimed 记录不该再产生评论、也不该把 seenSeq 回退成待重试。
    const routable = new Map(
      config.repositories
        .filter((repository) => repository.machineId === config.runnerId)
        .map((repository) => [repository.repo, repository]),
    );
    let migrated = 0;
    for (const [repo, bucket] of Object.entries(state.repositories)) {
      if (!routable.has(repo)) continue;
      for (const [number, entry] of Object.entries(bucket)) {
        // 旧版本状态先迁移，下面的 retryable 判定才能看到 legacyStuck 标记。
        const migratedHere = migrateLegacyProgress(entry);
        if (migratedHere > 0) {
          migrated += migratedHere;
          log(`状态来自旧版本：${repo}#${number} 有 ${migratedHere} 条命令曾被当成基线吞掉，已回退进度以便重新受理`);
        }
        const claimed = (entry.commands ?? []).filter((item) => item.status === 'claimed');
        if (claimed.length === 0) continue;
        const binding = entry.binding ?? null;
        const retryable = binding === null;
        for (const command of claimed) {
          command.status = 'uncertain';
          command.finishedAt = new Date().toISOString();
          // 旧版本里被当成基线吞掉的命令标了 legacyStuck：即使有绑定也允许重试（那次调用从未开始）。
          command.retryable = command.legacyStuck === true ? true : retryable;
        }
        entry.inFlight = false; // 残留标记必须清掉，否则下一条命令会被当成忙碌。
        // 有待重试的命令时把进度退到它之前，让它在下一轮作为「新命令」被重新受理一次；
        // 受理时只多认领这一条，其它已处理评论仍由状态里的记录挡住。
        const firstRetryable = claimed.find((command) => command.retryable === true);
        if (firstRetryable !== undefined) {
          entry.seenSeq = Math.max(0, firstRetryable.id - 1);
        }
        save();
        for (const command of claimed) {
          await feedback({
            repo,
            issueNumber: Number(number),
            body: formatComment({
              kind: 'uncertain',
              binding,
              detail: command.retryable === true
                ? `评论 ${command.id} 已登记但上次停在准备工作目录阶段、没有真正开始调用；本条会在下一轮检查时重试一次。`
                : `上一次调用（评论 ${command.id}）没有留下可判读的结束记录，程序在恢复时发现中断。绑定与工作目录保留，请核对后另发一条新指令。`,
            }),
          });
        }
      }
    }
    return migrated;
  }

  /**
   * 跑一轮检查。返回本轮是否所有仓库都读成功——`--once` 用它决定退出码，避免「未登录／
   * 权限不足／限流」时静默返回成功。
   */
  async function cycle() {
    const failures = [];
    for (const repository of config.repositories) {
      if (repository.machineId !== config.runnerId) {
        log(`配置跳过 ${repository.repo}：machineId=${repository.machineId}，本机 ${config.runnerId}`);
        continue;
      }
      const ok = await runRepository(repository);
      if (ok === false) failures.push(repository.repo);
    }
    return { failures };
  }

  return { cycle, recover, execute, handleComments, stateFile, state };
}
