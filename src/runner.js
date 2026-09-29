/**
 * 轮询、容量临界区、条件式领取、Harness 生命周期与最小 GitHub 反馈。
 *
 * 语义依据：
 * - docs/current/03-runner-trigger.md（Body 一次性入口、整批评论只取最新有效控制评论）；
 * - docs/current/04-local-state.md（水位 / Body 已处理与 starting 同一次原子写入、恢复语义）；
 * - docs/current/05-harness-scheduling.md（两级并发、每轮最多领取一个 Issue、Issue single-flight）。
 *
 * 领取路径严格分三步，且顺序不可交换：
 *   1. 临界区外读取 GitHub 快照（Issue / 评论）；
 *   2. 临界区内复核容量与条件，一次写入水位 + lastTrigger + binding + starting；
 *   3. 写入成功后（且只在成功后）准备目录并 spawn Harness。
 */

import { randomBytes } from 'node:crypto';

import { HARNESS_FAILURE, classifyHarnessResult, runDirFor } from './harness.js';
import { pruneRunDirs, truncateDiagnostic } from './log.js';
import { buildTaskMessage } from './prompt.js';
import {
  ConditionFailed,
  activeRunForIssue,
  issueState,
  machineActiveCount,
  pruneEndedRuns,
  repoActiveCount,
  repositoryState,
} from './state.js';
import {
  commentsAfterWatermark,
  evaluateIssueBody,
  isBotFeedback,
  pickLatestEligibleComment,
  scanEndpoint,
} from './trigger.js';

/** 公开失败反馈只使用这些稳定标签，不转述原始 stderr、模型输出或本机路径。 *//** 同一轮未发出的控制反馈最多补发几次，避免永久性故障下无限重试。 */
const FEEDBACK_MAX_ATTEMPTS = 5;

const FAILURE_LABELS = Object.freeze({
  [HARNESS_FAILURE.spawnFailed]: 'Harness 进程未能启动',
  [HARNESS_FAILURE.timeout]: '本机调用超时',
  [HARNESS_FAILURE.sessionBusy]: 'Harness 会话已被其他写入者占用',
  [HARNESS_FAILURE.sessionRefused]: 'Harness 会话无法续接',
  [HARNESS_FAILURE.sessionMismatch]: 'Harness 会话与任务绑定不一致',
  [HARNESS_FAILURE.harnessError]: 'Harness 未能进入可工作 session',
  [HARNESS_FAILURE.roundFailed]: 'Harness 本轮未能正常完成',
  workdir_failed: '任务工作目录准备失败',
  binding_config_mismatch: '任务绑定与当前配置不一致',
  task_dir_missing: '任务工作目录不存在',
  task_dir_not_worktree: '任务工作目录不是 git worktree',
  source_dir_missing: '源仓库目录不存在',
  base_branch_missing: '起点分支不存在',
  worktree_add_failed: '创建任务 worktree 失败',
  session_unresolved: '本机存在未确认的遗留会话',
  binding_owner_mismatch: '任务绑定属于另一台 Runner',
  worktree_source_mismatch: '任务工作目录不属于配置的源仓库',
});

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {import('./state.js').StateStore} deps.store
 * @param {object} deps.github
 * @param {object} deps.harness
 * @param {object} deps.workdir
 * @param {object} deps.audit
 * @param {object} [deps.logger]
 * @param {() => Date} [deps.clock]
 */
export function createRunner(deps) {
  const { config, store, github, harness, workdir, audit } = deps;
  const logger = deps.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
  const clock = deps.clock ?? (() => new Date());
  /** 本进程正在管理的运行；恢复核对不重复处理它们。 */
  const localRuns = new Set();
  /** 同一运行同一种反馈的进行中发布；并发调用共享同一次 GitHub 回查与发布。 */
  const feedbackInFlight = new Map();

  const nowIso = () => clock().toISOString();

  /**
   * 启动时与每轮开始时核对活跃运行态：确认仍在运行的继续占槽，确认已退出的结算并释放，
   * 无法确认的保守标记 unknown 并继续占槽（等待探测结果或维护者恢复动作）。
   */
  /**
   * 补发已经结束、但控制反馈尚未确认发出的运行。GitHub 临时故障不应永久丢掉 Contract 要求的接单 / 失败回复。
   */
  async function retryPendingFeedback() {
    const pending = Object.values(store.read().activeRuns).filter(
      (run) =>
        !localRuns.has(run.runId)
        && run.status === 'exited'
        && typeof run.feedbackExpectation === 'string'
        && run.feedback?.[run.feedbackExpectation] !== true
        && (run.feedbackAttempts ?? 0) < FEEDBACK_MAX_ATTEMPTS,
    );
    for (const run of pending) {
      await store.update((draft) => {
        const record = draft.activeRuns[run.runId];
        if (record) record.feedbackAttempts = (record.feedbackAttempts ?? 0) + 1;
      });
      if (run.feedbackExpectation === 'success' && run.sessionId) {
        await ensureSuccessFeedback(run, run.sessionId);
      } else {
        await ensureFailureFeedback(run, run.outcome ?? 'harness_error');
      }
    }
    for (const run of Object.values(store.read().activeRuns)) {
      if (run.status !== 'exited' || run.feedbackAbandoned === true) continue;
      if (typeof run.feedbackExpectation !== 'string') continue;
      if (run.feedback?.[run.feedbackExpectation] === true) continue;
      if ((run.feedbackAttempts ?? 0) < FEEDBACK_MAX_ATTEMPTS) continue;
      await store.update((draft) => {
        const record = draft.activeRuns[run.runId];
        if (record) record.feedbackAbandoned = true;
      });
      audit.append({
        event: 'feedback_abandoned',
        runId: run.runId,
        repository: run.repository,
        issueNumber: run.issueNumber,
        kind: run.feedbackExpectation,
        attempts: run.feedbackAttempts ?? 0,
      });
      logger.warn(`运行 ${run.runId} 的控制反馈补发 ${FEEDBACK_MAX_ATTEMPTS} 次仍未成功，转人工核对`);
    }
  }

  async function recoverActiveRuns() {
    const active = Object.values(store.read().activeRuns).filter((run) => !localRuns.has(run.runId));
    for (const run of active) {
      if (!['starting', 'running', 'unknown'].includes(run.status)) continue;
      if (!run.pid) {
        if (run.status !== 'unknown') {
          await markRun(run.runId, { status: 'unknown', outcome: 'spawn_unconfirmed', lastObservedAt: nowIso() });
        }
        logger.warn(`运行 ${run.runId} 的 spawn 结果未确认，保守占槽，需要人工核对`);
        continue;
      }
      const verdict = await harness.probe(run.pid, run.pidSignature ?? null);
      if (verdict === 'alive') {
        if (run.status !== 'running') {
          await markRun(run.runId, { status: 'running', lastObservedAt: nowIso() });
          logger.info(`运行 ${run.runId} 的 Harness 仍在运行，继续占槽`);
        }
        continue;
      }
      if (verdict === 'gone' || verdict === 'reused') {
        await finalizeOrphan(run, verdict);
        continue;
      }
      if (run.status !== 'unknown') {
        await markRun(run.runId, { status: 'unknown', outcome: 'process_unconfirmed', lastObservedAt: nowIso() });
        logger.warn(`无法确认运行 ${run.runId} 的进程状态，保守占槽`);
      }
    }
  }

  /**
   * 孤儿运行结算：按捕获文件判断本轮走到哪一步，只发布有证据的最小反馈。
   */
  async function finalizeOrphan(run, verdict) {
    const capture = harness.readCapture(run.runDir);
    harness.finalizeCapture?.(run.runDir);
    const requestedSession = run.sessionId ?? null;
    const capturedSession = capture.sessionId ?? null;
    // 与正常结算同一判据：续接返回的会话标识与绑定不一致时不采信，也不据此发布接单确认。
    const sessionMismatch = run.kind === 'resume'
      && requestedSession !== null
      && capturedSession !== null
      && capturedSession !== requestedSession;
    const sessionId = sessionMismatch ? requestedSession : requestedSession ?? capturedSession;
    // 没有任何会话证据（进程跑过却从未出现 session 事件）时，无法排除会话已建立，按绑定不明确处理。
    const sessionUnknown = !sessionMismatch && requestedSession === null && capturedSession === null;
    // 只有 sessionId 而没有已提交助手内容，不算“进入可工作 session”。
    const enteredWorkableSession = !sessionMismatch
      && sessionId !== null
      && (capture.hadAssistantCommit || capture.turnEndReason === 'completed');
    const feedbackExpectation = enteredWorkableSession ? 'success' : 'failure';
    const outcome = sessionMismatch
      ? 'session_mismatch'
      : capture.turnEndReason === 'completed'
        ? 'orphan_completed'
        : sessionId === null
          ? 'orphan_no_session'
          : 'orphan_lost';

    await store.update((draft) => {
      const record = draft.activeRuns[run.runId];
      if (record) {
        record.status = 'exited';
        record.endedAt = nowIso();
        record.lastObservedAt = record.endedAt;
        record.exitCode = null;
        record.outcome = outcome;
        record.sessionId = sessionId;
        record.recovered = { verdict, at: record.endedAt };
      }
      const issue = issueState(draft, run.repository, run.issueNumber);
      if (issue.binding && !issue.binding.sessionId && sessionId && !sessionMismatch) {
        issue.binding.sessionId = sessionId;
      }
      if (issue.binding && sessionUnknown) issue.binding.sessionUnresolved = true;
      if (issue.lastRun) {
        issue.lastRun.exitCode = null;
        issue.lastRun.outcome = outcome;
        issue.lastRun.endedAt = record?.endedAt ?? nowIso();
      }
      if (issue.lastTrigger && issue.lastTrigger.sourceId === run.trigger?.sourceId) {
        issue.lastTrigger.status = outcome;
      }
      const recoveredRecord = draft.activeRuns[run.runId];
      if (recoveredRecord) recoveredRecord.feedbackExpectation = feedbackExpectation;
    });

    audit.append({
      event: 'run_recovered',
      runId: run.runId,
      repository: run.repository,
      issueNumber: run.issueNumber,
      verdict,
      outcome,
      sessionId,
      sessionMismatch,
      sessionUnknown,
      pid: run.pid,
    });

    if (enteredWorkableSession) {
      await ensureSuccessFeedback(run, sessionId);
    } else if (!capture.exists) {
      await ensureFailureFeedback(run, 'session_unresolved');
    } else {
      await ensureFailureFeedback(run, 'harness_error');
    }
  }

  /**
   * 一次 polling cycle：机器满载时直接结束；否则按轮转顺序检查仓库，本轮最多领取一个 Issue。
   */
  async function runCycle() {
    const summary = { claimed: null, scanned: [], errors: [] };
    await recoverActiveRuns();
    await retryPendingFeedback();
    await store.update((draft) => {
      pruneEndedRuns(draft, clock().getTime());
    });

    // 保留策略与本轮结果无关：放在领取之前，失败路径同样会被清理。
    const protect = Object.values(store.read().activeRuns)
      .filter((run) => ['starting', 'running', 'unknown'].includes(run.status))
      .map((run) => run.runDir)
      .filter((dir) => typeof dir === 'string');
    const pruned = pruneRunDirs(config.runtime.stateDir, config.runtime.keepRunLogs, { protect });
    if (pruned.removed.length > 0) logger.info(`清理了 ${pruned.removed.length} 个历史运行目录`);

    if (machineActiveCount(store.read()) >= config.runtime.maxConcurrentHarnesses) {
      logger.info('机器级 Harness 槽位已满，本轮不扫描 GitHub');
      return summary;
    }

    const repositories = config.repositories;
    const cursor = store.read().scheduler?.repoCursor ?? 0;
    for (let offset = 0; offset < repositories.length; offset += 1) {
      const index = (cursor + offset) % repositories.length;
      const repository = repositories[index];
      try {
        if (!(await ensureBaseline(repository))) continue;
        if (repoActiveCount(store.read(), repository.repo) >= repository.maxConcurrentHarnesses) {
          logger.info(`${repository.repo} 已达仓库级并发上限，本轮跳过`);
          continue;
        }
        const outcome = await scanRepository(repository, index);
        summary.scanned.push({ repo: repository.repo, claimed: outcome.claimed });
        if (outcome.claimed) {
          summary.claimed = outcome.claimed;
          return summary;
        }
      } catch (error) {
        summary.errors.push({ repo: repository.repo, message: truncateDiagnostic(error.message) });
        logger.error(`${repository.repo} 本轮失败: ${truncateDiagnostic(error.message)}`);
      }
    }
    return summary;
  }

  /**
   * 首次接入的 baseline：全部落盘后才把 baselineCompleted 置真；中断则下次从头重做。
   * @param {object} repository
   * @returns {Promise<boolean>} 是否可以进入正常增量轮询
   */
  async function ensureBaseline(repository) {
    const repo = repository.repo;
    if (store.read().repositories[repo]?.baselineCompleted === true) return true;

    await store.update((draft) => {
      const record = repositoryState(draft, repo);
      if (!record.baselineCompleted) record.baselineStartedAt = nowIso();
    });

    const listed = await github.listOpenIssues(repo, {
      pageSize: config.github.pageSize,
      maxPages: config.github.maxPages,
    });
    if (listed.truncated) {
      logger.warn(`${repo} baseline 分页未完成，本轮不标记 baselineCompleted`);
      return false;
    }

    const entries = [];
    for (const issue of listed.items) {
      const total = Number(issue.comments ?? 0);
      let watermark = null;
      if (Number.isFinite(total) && total > 0) {
        const comments = await github.listRecentComments(repo, issue.number, { pageSize: 1, total });
        const last = comments.at(-1);
        watermark = last === undefined ? null : String(last.id);
      }
      entries.push({ number: issue.number, watermark });
    }

    const completedAt = nowIso();
    await store.update((draft) => {
      const record = repositoryState(draft, repo);
      for (const entry of entries) {
        const issue = issueState(draft, repo, entry.number);
        issue.issueBodyHandled = true;
        issue.commentScanWatermark = entry.watermark;
        issue.commentScanWatermarkAt = completedAt;
      }
      record.baselineCompleted = true;
      record.baselineCompletedAt = completedAt;
      record.lastScanAt = completedAt;
    });

    audit.append({ event: 'baseline_completed', repository: repo, issues: entries.length, at: completedAt });
    logger.info(`${repo} baseline 完成，共 ${entries.length} 个 Issue；此后才进入正常接单`);
    return true;
  }

  /**
   * 扫描单个仓库：整批处理完才推进仓库扫描窗口；一旦领取就结束本轮。
   * @param {object} repository
   * @param {number} index
   */
  async function scanRepository(repository, index) {
    const repo = repository.repo;
    const lastScanAt = store.read().repositories[repo]?.lastScanAt ?? null;
    // 与评论扫描一样留 1 秒重叠：since 边界上的更新不会被永久漏掉，只会被多读一次。
    const since = lastScanAt === null ? null : new Date(Math.max(0, Date.parse(lastScanAt) - 1_000)).toISOString();
    const scanStartedAt = nowIso();
    const listed = await github.listIssuesSince(repo, {
      since,
      pageSize: config.github.pageSize,
      maxPages: config.github.maxPages,
    });
    if (listed.truncated) {
      throw new Error('Issue 分页未完成，本轮不推进扫描窗口');
    }

    for (const issue of listed.items) {
      const result = await considerIssue(repository, issue, since ?? scanStartedAt);
      if (result.claimed) {
        await store.update((draft) => {
          draft.scheduler.repoCursor = (index + 1) % config.repositories.length;
        });
        return { claimed: result.claimed };
      }
    }

    await store.update((draft) => {
      const record = repositoryState(draft, repo);
      if (record.baselineCompleted) record.lastScanAt = scanStartedAt;
    });
    return { claimed: null };
  }

  /**
   * 处理一个 Issue：运行中直接跳过；未处理 Body 时先做一次性 Body 判定；否则扫描评论。
   * @param {object} repository
   * @param {object} issue
   * @param {string} windowStart 本轮仓库扫描窗口起点
   */
  async function considerIssue(repository, issue, windowStart) {
    const repo = repository.repo;
    if (activeRunForIssue(store.read(), repo, issue.number)) {
      return { skipped: 'issue_active' };
    }
    const record = store.read().repositories[repo]?.issues?.[String(issue.number)];
    if (!record || record.issueBodyHandled !== true) {
      return handleIssueBody(repository, issue, windowStart);
    }
    return scanIssueComments(repository, issue);
  }

  /** Issue Body 是一次性入口：只判断一次，不因重复扫描或编辑重新评估。 */
  async function handleIssueBody(repository, issue, windowStart) {
    const repo = repository.repo;
    const decision = evaluateIssueBody(issue, {
      runnerName: config.runnerName,
      allowedActors: repository.allowedActors,
    });

    if (!decision.command) {
      try {
        await store.update((draft) => {
          const record = issueState(draft, repo, issue.number);
          if (record.issueBodyHandled) throw new ConditionFailed('body_already_handled');
          record.issueBodyHandled = true;
          record.commentScanWatermark = null;
          record.commentScanWatermarkAt = windowStart ?? nowIso();
        });
      } catch (error) {
        if (!(error instanceof ConditionFailed)) throw error;
        return { skipped: 'body_race' };
      }
      audit.append({
        event: 'issue_body_handled',
        repository: repo,
        issueNumber: issue.number,
        author: decision.author,
        reason: decision.reason,
      });
      // 同一轮继续按正常增量路径扫描该 Issue 的评论：Body 不是命令不代表可以漏掉窗口内已有的控制评论。
      return scanIssueComments(repository, issue);
    }

    return claim({
      repository,
      issue,
      sourceType: 'issue_body',
      sourceId: `issue-${issue.number}-body`,
      author: decision.author,
    });
  }

  /** 评论路径：整批新评论只取最新一条有效控制评论，普通 / 未授权 / BOT 评论只推进水位。 */
  async function scanIssueComments(repository, issue) {
    const repo = repository.repo;
    const record = store.read().repositories[repo]?.issues?.[String(issue.number)];
    const watermarkId = record?.commentScanWatermark ?? null;
    const watermarkAt = record?.commentScanWatermarkAt ?? null;
    const scanStartedAt = nowIso();
    const since = watermarkAt ? new Date(Math.max(0, Date.parse(watermarkAt) - 1_000)).toISOString() : null;

    const listed = await github.listComments(repo, issue.number, {
      since,
      pageSize: config.github.pageSize,
      maxPages: config.github.maxPages,
    });
    if (listed.truncated) {
      throw new Error('评论分页未完成，本轮不推进水位');
    }

    const fresh = commentsAfterWatermark(listed.items, watermarkId);
    if (fresh.length === 0) return { scanned: 0 };

    const endpoint = scanEndpoint(fresh);
    const candidate = pickLatestEligibleComment(fresh, {
      runnerName: config.runnerName,
      allowedActors: repository.allowedActors,
    });

    if (!candidate) {
      try {
        await store.update((draft) => {
          if (activeRunForIssue(draft, repo, issue.number)) throw new ConditionFailed('issue_active');
          const current = issueState(draft, repo, issue.number);
          if (current.commentScanWatermark !== watermarkId || current.commentScanWatermarkAt !== watermarkAt) {
            throw new ConditionFailed('watermark_moved');
          }
          current.commentScanWatermark = endpoint;
          current.commentScanWatermarkAt = scanStartedAt;
        });
      } catch (error) {
        if (!(error instanceof ConditionFailed)) throw error;
        return { skipped: error.message };
      }
      audit.append({
        event: 'comments_scanned',
        repository: repo,
        issueNumber: issue.number,
        scanned: fresh.length,
        watermark: endpoint,
      });
      return { scanned: fresh.length };
    }

    // 候选版本校验：候选在读取后被编辑或出现更新的有效控制评论时，本次不领取。
    const verified = await verifyCandidate(repository, issue.number, {
      candidate,
      watermarkId,
      watermarkAt,
      endpoint,
      since,
    });
    if (!verified.ok) return { skipped: verified.reason };

    return claim({
      repository,
      issue,
      sourceType: 'comment',
      sourceId: String(candidate.id),
      author: candidate.user?.login ?? null,
      watermarkId,
      watermarkAt,
      endpoint,
      scanStartedAt,
    });
  }

  /**
   * 重新读取本轮窗口并复核候选：同一候选必须仍是最新一条有效控制评论，正文版本未变。
   */
  async function verifyCandidate(repository, issueNumber, input) {
    const listed = await github.listComments(repository.repo, issueNumber, {
      since: input.since,
      pageSize: config.github.pageSize,
      maxPages: config.github.maxPages,
    });
    if (listed.truncated) return { ok: false, reason: 'comment_page_truncated' };
    const fresh = commentsAfterWatermark(listed.items, input.watermarkId);
    const endpoint = scanEndpoint(fresh);
    const candidate = pickLatestEligibleComment(fresh, {
      runnerName: config.runnerName,
      allowedActors: repository.allowedActors,
    });
    if (candidate === null) return { ok: false, reason: 'candidate_gone' };
    if (String(candidate.id) !== String(input.candidate.id)) return { ok: false, reason: 'newer_candidate' };
    if (String(candidate.updated_at) !== String(input.candidate.updated_at)) {
      return { ok: false, reason: 'candidate_edited' };
    }
    if (endpoint !== input.endpoint) return { ok: false, reason: 'endpoint_moved' };
    return { ok: true };
  }

  /**
   * 条件式领取：临界区内复核容量与触发条件，一次写入水位 / lastTrigger / binding / starting。
   * 只有写入成功的执行者才会继续 spawn。
   */
  async function claim(input) {
    const { repository, issue } = input;
    const repo = repository.repo;
    const snapshot = store.read().repositories[repo]?.issues?.[String(issue.number)] ?? null;
    const existingBinding = snapshot?.binding ?? null;
    const kind = existingBinding?.sessionId ? 'resume' : 'start';

    if (existingBinding?.runnerName && existingBinding.runnerName !== config.runnerName) {
      audit.append({
        event: 'claim_refused',
        repository: repo,
        issueNumber: issue.number,
        reason: 'binding_owner_mismatch',
        bindingRunner: existingBinding.runnerName,
      });
      await sendRefusalFeedback(repository, issue, 'binding_owner_mismatch');
      return { refused: 'binding_owner_mismatch' };
    }

    if (kind === 'start' && existingBinding?.sessionUnresolved === true) {
      audit.append({
        event: 'claim_refused',
        repository: repo,
        issueNumber: issue.number,
        reason: 'session_unresolved',
      });
      await sendRefusalFeedback(repository, issue, 'session_unresolved');
      return { refused: 'session_unresolved' };
    }

    const dir = kind === 'resume' ? existingBinding.dir : workdir.taskDirFor(repository, issue.number);
    const branch = kind === 'resume' ? existingBinding.branch : workdir.branchFor(issue.number);
    const source = kind === 'resume' ? existingBinding.source : repository.sourceDir;
    const sessionId = kind === 'resume' ? existingBinding.sessionId : null;
    const runId = newRunId(clock());
    const claimedAt = nowIso();

    let claimResult;
    try {
      claimResult = await store.update((draft) => {
        if (activeRunForIssue(draft, repo, issue.number)) throw new ConditionFailed('issue_active');
        if (machineActiveCount(draft) >= config.runtime.maxConcurrentHarnesses) {
          throw new ConditionFailed('machine_capacity');
        }
        if (repoActiveCount(draft, repo) >= repository.maxConcurrentHarnesses) {
          throw new ConditionFailed('repo_capacity');
        }

        const record = issueState(draft, repo, issue.number);
        if (input.sourceType === 'comment') {
          if (record.commentScanWatermark !== input.watermarkId || record.commentScanWatermarkAt !== input.watermarkAt) {
            throw new ConditionFailed('watermark_moved');
          }
          record.commentScanWatermark = input.endpoint;
          record.commentScanWatermarkAt = input.scanStartedAt;
        } else {
          if (record.issueBodyHandled) throw new ConditionFailed('body_handled');
          record.issueBodyHandled = true;
          record.commentScanWatermark = null;
          record.commentScanWatermarkAt = claimedAt;
        }

        const trigger = {
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          author: input.author ?? null,
          at: claimedAt,
          status: 'starting',
          feedbackSent: false,
        };
        record.lastTrigger = trigger;
        record.binding = {
          runnerName: config.runnerName,
          dir,
          sessionId,
          branch,
          source,
          worktreeCreated: kind === 'resume' ? Boolean(existingBinding.worktreeCreated) : false,
          createdAt: claimedAt,
        };
        record.lastRun = {
          at: claimedAt,
          dir,
          runDir: runDirFor(config, runId),
          exitCode: null,
          outcome: 'starting',
        };
        draft.activeRuns[runId] = {
          runId,
          repository: repo,
          issueNumber: issue.number,
          trigger,
          runnerName: config.runnerName,
          kind,
          dir,
          sessionId,
          pid: null,
          pidSignature: null,
          status: 'starting',
          startedAt: claimedAt,
          lastObservedAt: claimedAt,
          endedAt: null,
          runDir: runDirFor(config, runId),
          feedback: { success: false, failure: false },
        };
        return { runId, trigger };
      });
    } catch (error) {
      if (!(error instanceof ConditionFailed)) throw error;
      logger.info(`${repo}#${issue.number} 领取条件不成立（${error.message}），本轮不启动`);
      return { skipped: error.message };
    }

    audit.append({
      event: 'trigger_claimed',
      runId: claimResult.runId,
      repository: repo,
      issueNumber: issue.number,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      author: input.author ?? null,
      runnerName: config.runnerName,
      kind,
      dir,
    });

    const run = {
      runId: claimResult.runId,
      repository: repo,
      issueNumber: issue.number,
      trigger: claimResult.trigger,
      kind,
      dir,
      sessionId,
      runDir: runDirFor(config, runId),
    };
    void executeRun(run, repository, issue).catch((error) => {
      logger.error(`运行 ${run.runId} 收尾失败: ${truncateDiagnostic(error.message)}`);
    });
    return { claimed: run };
  }

  /**
   * 领取成功之后的实际执行：准备目录 → spawn → 早期补全 sessionId → 接单确认 → 结算。
   */
  async function executeRun(run, repository, issue) {
    localRuns.add(run.runId);
    try {
      let prepared;
      try {
        prepared = await workdir.prepare({
          repository,
          issueNumber: run.issueNumber,
          kind: run.kind,
          binding: store.read().repositories[run.repository]?.issues?.[String(run.issueNumber)]?.binding ?? null,
        });
      } catch (error) {
        await failRun(run, error.category ?? 'workdir_failed', error.message);
        return;
      }

      const branchDrift = prepared.currentBranch !== null && prepared.branch !== prepared.currentBranch;
      if (branchDrift) {
        logger.warn(
          `${run.repository}#${run.issueNumber} 工作目录当前在 ${prepared.currentBranch}，绑定记录为 ${prepared.branch}；按现有检出继续`,
        );
        audit.append({
          event: 'workdir_branch_drift',
          runId: run.runId,
          repository: run.repository,
          issueNumber: run.issueNumber,
          bindingBranch: prepared.branch,
          currentBranch: prepared.currentBranch,
        });
      }
      await store.update((draft) => {
        const record = draft.activeRuns[run.runId];
        if (record) {
          record.dir = prepared.dir;
          record.currentBranch = prepared.currentBranch;
          record.branchDrift = branchDrift;
        }
        const issueRecord = issueState(draft, run.repository, run.issueNumber);
        if (issueRecord.binding) issueRecord.binding.worktreeCreated = prepared.worktreeCreated;
        if (issueRecord.lastRun) issueRecord.lastRun.dir = prepared.dir;
      });

      const task = buildTaskMessage({
        kind: run.kind,
        repository: run.repository,
        issueNumber: run.issueNumber,
        sourceType: run.trigger.sourceType,
        sourceId: run.trigger.sourceId,
        requester: run.trigger.author,
      });

      let handle;
      try {
        handle = harness.launch({
          runId: run.runId,
          kind: run.kind,
          dir: prepared.dir,
          sessionId: run.kind === 'resume' ? run.sessionId : null,
          task,
          runDir: run.runDir,
        });
      } catch (error) {
        // 创建 run 目录 / 打开捕获文件等 pre-spawn 失败：按启动失败结算，不留永久 starting。
        await failRun(run, HARNESS_FAILURE.spawnFailed, error.message);
        return;
      }

      const pid = handle.pid;
      // 进程签名只是避免 PID 重用误判的附加证据；取不到时不影响本轮调用。
      const signature = pid === null ? null : await harness.readSignature(pid).catch(() => null);
      await store.update((draft) => {
        const record = draft.activeRuns[run.runId];
        if (!record) return;
        record.pid = pid;
        record.pidSignature = signature;
        record.status = pid === null ? 'unknown' : 'running';
        record.lastObservedAt = nowIso();
      });
      audit.append({
        event: 'harness_spawned',
        runId: run.runId,
        repository: run.repository,
        issueNumber: run.issueNumber,
        kind: run.kind,
        dir: prepared.dir,
        pid,
      });

      // 会话标识一到就补全绑定，不等整轮结束。
      void handle.sessionId.then(async (sessionId) => {
        if (!sessionId || handle.record.sessionMismatch) return;
        await persistSessionId(run, sessionId);
      });

      // 早期判据：模型产出第一个已提交的助手内容，说明本轮确实进入了可工作 session。
      void handle.earlySignal.then(async (entered) => {
        if (!entered || handle.record.sessionMismatch) return;
        const sessionId = (await handle.sessionId) ?? run.sessionId ?? null;
        if (!sessionId) return;
        await ensureSuccessFeedback(run, sessionId);
      });

      const result = await handle.exited;
      await finishRun(run, result);
    } finally {
      localRuns.delete(run.runId);
    }
  }

  /** 结算一次调用：写本机技术结果，必要时补发最小 GitHub 反馈。 */
  async function finishRun(run, result) {
    const verdict = classifyHarnessResult(result);
    harness.finalizeCapture?.(result.runDir);
    // 会话不匹配时绝不采信返回的另一个 session 标识，也不改写绑定。
    const sessionId = result.sessionMismatch ? run.sessionId ?? null : result.sessionId ?? run.sessionId ?? null;
    // 进程确实启动过、却始终没有 session 事件：无法排除“会话已建立但标识没拿到”，按绑定不明确处理。
    const ambiguousSession = sessionId === null && result.spawnError === null;
    // 接单确认要求“已进入可工作 session”：既要有绑定的 sessionId，也要有本轮确实产生过
    // 已提交助手内容的证据；只有标识而没有可工作轮次时按启动失败处理（03-runner-trigger.md）。
    const enteredWorkableSession = !result.sessionMismatch
      && sessionId !== null
      && (Boolean(result.hadAssistantCommit) || verdict.ok);

    await store.update((draft) => {
      const record = draft.activeRuns[run.runId];
      if (record) {
        record.status = 'exited';
        record.endedAt = nowIso();
        record.lastObservedAt = record.endedAt;
        record.exitCode = result.exitCode;
        record.outcome = verdict.ok ? 'turn_completed' : verdict.category;
        record.sessionId = sessionId;
        record.diagnostics = {
          turnEnd: result.turnEndReason ?? null,
          events: result.eventCount ?? 0,
          invalidLines: result.invalidLines ?? 0,
          timedOut: Boolean(result.timedOut),
          spawnError: result.spawnError?.code ?? null,
        };
      }
      const issue = issueState(draft, run.repository, run.issueNumber);
      if (issue.binding && !issue.binding.sessionId && sessionId && !result.sessionMismatch) {
        issue.binding.sessionId = sessionId;
      }
      if (issue.binding && ambiguousSession) issue.binding.sessionUnresolved = true;
      if (issue.lastRun) {
        issue.lastRun.exitCode = result.exitCode;
        issue.lastRun.outcome = record?.outcome ?? null;
        issue.lastRun.endedAt = record?.endedAt ?? nowIso();
      }
      if (issue.lastTrigger && issue.lastTrigger.sourceId === run.trigger.sourceId) {
        issue.lastTrigger.status = record?.outcome ?? null;
        issue.lastTrigger.finishedAt = record?.endedAt ?? nowIso();
      }
      if (record) record.feedbackExpectation = enteredWorkableSession ? 'success' : 'failure';
    });

    audit.append({
      event: 'run_end',
      runId: run.runId,
      repository: run.repository,
      issueNumber: run.issueNumber,
      kind: run.kind,
      sessionId,
      exitCode: result.exitCode,
      signal: result.signal ?? null,
      outcome: verdict.ok ? 'turn_completed' : verdict.category,
      turnEnd: result.turnEndReason ?? null,
      timedOut: Boolean(result.timedOut),
      pid: store.read().activeRuns[run.runId]?.pid ?? null,
      startedAt: store.read().activeRuns[run.runId]?.startedAt ?? null,
      endedAt: store.read().activeRuns[run.runId]?.endedAt ?? null,
    });

    const feedback = store.read().activeRuns[run.runId]?.feedback ?? { success: false, failure: false };
    if (enteredWorkableSession) {
      if (!feedback.success) await ensureSuccessFeedback(run, sessionId);
    } else {
      await ensureFailureFeedback(run, verdict.ok ? HARNESS_FAILURE.harnessError : verdict.category);
    }
  }

  /** 目录、spawn 之前的准备失败：不启动 Harness，按启动失败留下最小反馈。 */
  async function failRun(run, category, diagnostic) {
    await store.update((draft) => {
      const record = draft.activeRuns[run.runId];
      if (record) {
        record.status = 'exited';
        record.endedAt = nowIso();
        record.lastObservedAt = record.endedAt;
        record.outcome = category;
        record.diagnostics = { diagnostic: truncateDiagnostic(diagnostic) };
      }
      const issue = issueState(draft, run.repository, run.issueNumber);
      if (issue.lastRun) {
        issue.lastRun.outcome = category;
        issue.lastRun.endedAt = record?.endedAt ?? nowIso();
      }
      if (issue.lastTrigger && issue.lastTrigger.sourceId === run.trigger.sourceId) {
        issue.lastTrigger.status = category;
      }
      if (record) record.feedbackExpectation = 'failure';
    });
    audit.append({
      event: 'run_failed',
      runId: run.runId,
      repository: run.repository,
      issueNumber: run.issueNumber,
      category,
      diagnostic: truncateDiagnostic(diagnostic),
    });
    await ensureFailureFeedback(run, category);
  }

  async function persistSessionId(run, sessionId) {
    await store.update((draft) => {
      const record = draft.activeRuns[run.runId];
      if (record) {
        record.sessionId = sessionId;
        record.lastObservedAt = nowIso();
      }
      const issue = issueState(draft, run.repository, run.issueNumber);
      if (issue.binding && !issue.binding.sessionId) issue.binding.sessionId = sessionId;
    });
    audit.append({
      event: 'session_bound',
      runId: run.runId,
      repository: run.repository,
      issueNumber: run.issueNumber,
      sessionId,
    });
  }

  /**
   * 接单确认：只在“已进入可工作 session 且已有 sessionId”后发布一次；
   * 重启后按 GitHub 上是否已存在对应评论回查，不依赖会被崩溃打断的布尔标记。
   */
  function oncePerRun(runId, kind, action) {
    const key = `${runId}:${kind}`;
    const pending = feedbackInFlight.get(key);
    if (pending !== undefined) return pending;
    const promise = Promise.resolve()
      .then(action)
      .finally(() => feedbackInFlight.delete(key));
    feedbackInFlight.set(key, promise);
    return promise;
  }

  async function ensureSuccessFeedback(run, sessionId) {
    return oncePerRun(run.runId, 'success', () => postSuccessFeedback(run, sessionId));
  }

  async function postSuccessFeedback(run, sessionId) {
    const record = store.read().activeRuns[run.runId];
    if (record?.feedback?.success) return true;
    try {
      // 幂等依据是本机 append-only 审计：不依赖 GitHub 与本机时钟顺序，也能区分复用同一 sessionId 的多次触发。
      const alreadySent = audit.has({ event: 'feedback_sent', runId: run.runId, kind: 'success' });
      if (!alreadySent) {
        await github.postComment(run.repository, run.issueNumber, successBody(sessionId));
      }
      await markFeedback(run.runId, 'success', { alreadyPresent: alreadySent });
      return true;
    } catch (error) {
      audit.append({
        event: 'feedback_failed',
        runId: run.runId,
        repository: run.repository,
        issueNumber: run.issueNumber,
        kind: 'success',
        diagnostic: truncateDiagnostic(error.message),
      });
      return false;
    }
  }

  /**
   * 启动失败反馈：Dev 没有进入可工作 session 时才发；重启后同样先回查再补发。
   */
  async function ensureFailureFeedback(run, category) {
    return oncePerRun(run.runId, 'failure', () => postFailureFeedback(run, category));
  }

  async function postFailureFeedback(run, category) {
    const record = store.read().activeRuns[run.runId];
    if (record?.feedback?.failure) return true;
    try {
      const alreadySent = audit.has({ event: 'feedback_sent', runId: run.runId, kind: 'failure' });
      if (!alreadySent) {
        await github.postComment(run.repository, run.issueNumber, failureBody(category));
      }
      await markFeedback(run.runId, 'failure', { category, alreadyPresent: alreadySent });
      return true;
    } catch (error) {
      audit.append({
        event: 'feedback_failed',
        runId: run.runId,
        repository: run.repository,
        issueNumber: run.issueNumber,
        kind: 'failure',
        diagnostic: truncateDiagnostic(error.message),
      });
      return false;
    }
  }

  /**
   * 绑定不明确时拒绝静默新建并行 session，只留下明确的人工恢复提示。
   * 该触发不会被消费（水位不动），因此必须先回查是否已经提示过，避免每轮重复刷同一条评论。
   */
  async function sendRefusalFeedback(repository, issue, category) {
    try {
      const alreadySent = audit.has({
        event: 'feedback_sent',
        repository: repository.repo,
        issueNumber: issue.number,
        kind: 'refusal',
        category,
      });
      if (!alreadySent) {
        await github.postComment(repository.repo, issue.number, failureBody(category));
      }
      audit.append({
        event: 'feedback_sent',
        repository: repository.repo,
        issueNumber: issue.number,
        kind: 'refusal',
        category,
        alreadyPresent: alreadySent,
      });
      return true;
    } catch (error) {
      audit.append({
        event: 'feedback_failed',
        repository: repository.repo,
        issueNumber: issue.number,
        kind: 'refusal',
        diagnostic: truncateDiagnostic(error.message),
      });
      return false;
    }
  }

  async function markFeedback(runId, kind, detail = {}) {
    const snapshot = store.read().activeRuns[runId];
    await store.update((draft) => {
      const record = draft.activeRuns[runId];
      if (!record) return;
      record.feedback = { ...record.feedback, [kind]: true, at: nowIso() };
      const issue = issueState(draft, record.repository, record.issueNumber);
      if (issue.lastTrigger) issue.lastTrigger.feedbackSent = true;
    });
    audit.append({
      event: 'feedback_sent',
      runId,
      repository: snapshot?.repository ?? null,
      issueNumber: snapshot?.issueNumber ?? null,
      kind,
      category: detail.category ?? null,
      alreadyPresent: Boolean(detail.alreadyPresent),
    });
  }

  async function markRun(runId, patch) {
    await store.update((draft) => {
      const record = draft.activeRuns[runId];
      if (record) Object.assign(record, patch);
    });
  }

  function successBody(sessionId) {
    return `BOT:${config.runnerName}\n${config.runnerName} 已接单，Session ID: ${sessionId}\n`;
  }

  function failureBody(category) {
    const label = FAILURE_LABELS[category] ?? '本机技术故障';
    return `BOT:${config.runnerName}\n${config.runnerName} 启动 Harness 失败（${label}），请检查本机 Runner / Harness 状态。\n`;
  }

  return {
    recoverActiveRuns,
    runCycle,
    /** 本进程仍在管理的运行数；`--once --wait` 与测试用。 */
    localRunCount: () => localRuns.size,
    hasLocalRun: (runId) => localRuns.has(runId),
  };
}

/**
 * @param {Date} date
 * @returns {string} 本机唯一 runId（不含路径与业务信息）
 */
export function newRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `run-${stamp}-${randomBytes(3).toString('hex')}`;
}
