// 本机持久化状态：仓库/Issue 的绑定、评论处理进度与调用记录。
//
// 状态文件只保存在本机（缺省 `<runtime.stateDir>/state.json`），不入库、不进入公开评论。
// 写入用「临时文件 + rename」，避免半截文件被当成有效状态；进度在启动会话之前落盘，
// 保证重复轮询、重复拉取与正常重启都不会重复启动同一任务。

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STATE_VERSION = 1;

export function emptyState() {
  return { version: STATE_VERSION, repositories: {} };
}

/** 以「仓库身份 + Issue 编号」寻址；不同仓库的同号 Issue 不混淆。 */
export function issueState(state, repo, issueNumber) {
  const bucket = (state.repositories[repo] ??= {});
  return (bucket[String(issueNumber)] ??= {
    seenSeq: 0,
    commands: [],
    binding: null,
    lastRun: null,
  });
}

/** 加载状态；文件不存在视为首次接入，损坏则明确失败，不覆盖原文件。 */
export function loadState(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new Error(`读取状态文件失败 ${path}：${error.message}`);
  }
  if (text.trim() === '') return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`状态文件不是合法 JSON（${path}）：${error.message}；请人工核对，程序不会覆盖它`);
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) {
    throw new Error(`状态文件版本不匹配（${path}）：期望 ${STATE_VERSION}，读到 ${parsed?.version}`);
  }
  parsed.repositories ??= {};
  return parsed;
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

export function statePath(stateDir) {
  return join(stateDir, 'state.json');
}

/** 追加一条命令处理记录；同一评论 id 只保留一条，避免重复轮询堆出重复记录。 */
export function recordCommand(issue, entry) {
  const existing = issue.commands.find((item) => item.id === entry.id);
  if (existing !== undefined) {
    Object.assign(existing, entry);
    return existing;
  }
  issue.commands.push(entry);
  return entry;
}

export function findCommand(issue, id) {
  return issue.commands.find((item) => item.id === id) ?? null;
}

/** 会话绑定：执行机、独立工作目录、会话标识与已知分支／PR 一起保存。 */
export function createBinding({ runnerId, dir, sessionId, branch, source, worktreeCreated }) {
  return { runnerId, dir, sessionId, branch, source, worktreeCreated, createdAt: new Date().toISOString() };
}

/** 绑定与当前配置是否仍然一致；不一致时报告而不是静默新开工作目录或新会话。 */
export function bindingProblems(binding, repository, runnerId) {
  const problems = [];
  if (binding === null || binding === undefined) return ['没有已保存的绑定'];
  if (binding.runnerId !== runnerId) problems.push(`绑定属于执行机 ${binding.runnerId}，本机是 ${runnerId}`);
  if (repository.sourceDir !== undefined && binding.source !== undefined
    && binding.source !== repository.sourceDir) {
    problems.push(`绑定来源 ${binding.source} 与配置 sourceDir ${repository.sourceDir} 不一致`);
  }
  return problems;
}
