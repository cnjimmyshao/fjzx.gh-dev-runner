// 本机配置：加载、展开路径并做启动前置校验。
//
// 配置是部署者在本机保存的唯一入口（缺省 `.local/config.json`），包含允许接入的
// 仓库、发起人、执行机标识、独立工作目录与 Harness 调用入口。凭证不写在这里：
// 模型 Key 仍按 Harness 受支持的方式提供，GitHub 权限复用已登录的 `gh`。

import { accessSync, constants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_CONFIG_PATH = join('.local', 'config.json');
export const DEFAULT_COMMAND = '@dev';
export const DEFAULT_POLL_SECONDS = 60;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function fail(message) {
  throw new ConfigError(message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} 必须是非空字符串`);
  return value.trim();
}

function optionalString(value, path) {
  if (value === undefined || value === null) return undefined;
  return requireString(value, path);
}

function requireStringArray(value, path) {
  if (!Array.isArray(value) || value.length === 0) fail(`${path} 必须是非空字符串数组`);
  return value.map((item, index) => requireString(item, `${path}[${index}]`));
}

/** `~` 与相对路径按配置文件所在目录展开；不做环境变量插值，避免把本机变量写进配置语义。 */
export function expandPath(value, baseDir) {
  const raw = value.trim();
  if (raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(baseDir, raw);
}

/** GitHub 仓库标识固定为 `owner/name`，用于路由与状态寻址，不接受 URL 或多余层级。 */
export function validateRepoName(value, path) {
  const name = requireString(value, path);
  const parts = name.split('/');
  if (parts.length !== 2 || parts.some((part) => part === '' || /\s/.test(part))) {
    fail(`${path} 必须是 owner/name 形式：${name}`);
  }
  return name;
}

/** 机器标识决定标签 `runner:<id>`，只允许字母数字、点、下划线与短横。 */
export function validateRunnerId(value, path) {
  const id = requireString(value, path);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) fail(`${path} 含非法字符（只允许字母数字与 . _ -）：${id}`);
  return id;
}

export function runnerLabel(runnerId) {
  return `runner:${runnerId}`;
}

export function parseConfig(raw, { configPath, machineId, home = homedir() } = {}) {
  const baseDir = configPath === undefined ? process.cwd() : dirname(resolve(configPath));
  if (!isPlainObject(raw)) fail('配置根节点必须是对象');

  const machine = optionalString(raw.machineId, 'machineId') ?? optionalString(machineId, '--machine-id');
  if (machine === undefined) {
    fail('缺少执行机标识：配置里写 machineId，或启动时给 --machine-id（可省 $env:COMPUTERNAME）');
  }
  const runnerId = validateRunnerId(machine, 'machineId');

  const harnessRaw = raw.harness;
  if (!isPlainObject(harnessRaw)) fail('缺少 harness 配置段');
  const harness = {
    bin: expandPath(requireString(harnessRaw.bin, 'harness.bin'), baseDir),
    profile: requireString(harnessRaw.profile ?? 'headless', 'harness.profile'),
    patch: expandPath(requireString(harnessRaw.patch, 'harness.patch'), baseDir),
    node: expandPath(optionalString(harnessRaw.node, 'harness.node') ?? process.execPath, baseDir),
    home: harnessRaw.home === undefined || harnessRaw.home === null
      ? undefined
      : expandPath(requireString(harnessRaw.home, 'harness.home'), baseDir),
    timeoutMs: Number.isInteger(harnessRaw.timeoutMs) && harnessRaw.timeoutMs > 0 ? harnessRaw.timeoutMs : 900000,
  };

  const githubRaw = raw.github ?? {};
  if (!isPlainObject(githubRaw)) fail('github 配置段必须是对象');
  const github = {
    command: optionalString(githubRaw.command, 'github.command') ?? DEFAULT_COMMAND,
    timeoutMs: Number.isInteger(githubRaw.timeoutMs) && githubRaw.timeoutMs > 0 ? githubRaw.timeoutMs : 120000,
    pageSize: Number.isInteger(githubRaw.pageSize) && githubRaw.pageSize > 0 && githubRaw.pageSize <= 100
      ? githubRaw.pageSize
      : 100,
  };

  const runtimeRaw = raw.runtime ?? {};
  if (!isPlainObject(runtimeRaw)) fail('runtime 配置段必须是对象');
  const stateDir = expandPath(optionalString(runtimeRaw.stateDir, 'runtime.stateDir') ?? join(home, '.fjzx-gh-dev-runner'), baseDir);
  const workspaceDir = expandPath(
    optionalString(runtimeRaw.workspaceDir, 'runtime.workspaceDir') ?? join(stateDir, 'workspaces'),
    baseDir,
  );
  const runtime = {
    stateDir,
    workspaceDir,
    pollSeconds: Number.isInteger(runtimeRaw.pollSeconds) && runtimeRaw.pollSeconds > 0
      ? runtimeRaw.pollSeconds
      : DEFAULT_POLL_SECONDS,
    logMode: optionalString(runtimeRaw.logMode, 'runtime.logMode') ?? 'file',
    keepRunLogs: Number.isInteger(runtimeRaw.keepRunLogs) && runtimeRaw.keepRunLogs > 0 ? runtimeRaw.keepRunLogs : 20,
  };
  if (runtime.logMode !== 'file' && runtime.logMode !== 'inherit') {
    fail(`runtime.logMode 只能是 file 或 inherit：${runtime.logMode}`);
  }

  if (!Array.isArray(raw.repositories) || raw.repositories.length === 0) {
    fail('repositories 必须是非空数组：本工具只处理显式接入的仓库');
  }
  const repositories = raw.repositories.map((item, index) => {
    const at = `repositories[${index}]`;
    if (!isPlainObject(item)) fail(`${at} 必须是对象`);
    const repo = validateRepoName(item.repo, `${at}.repo`);
    const machineIdValue = validateRunnerId(item.machineId ?? runnerId, `${at}.machineId`);
    const sourceDir = item.sourceDir === undefined || item.sourceDir === null
      ? undefined
      : expandPath(requireString(item.sourceDir, `${at}.sourceDir`), baseDir);
    const repoDir = item.repoDir === undefined || item.repoDir === null
      ? undefined
      : expandPath(requireString(item.repoDir, `${at}.repoDir`), baseDir);
    if (sourceDir === undefined && repoDir === undefined) {
      fail(`${at} 需要 sourceDir（执行 git worktree 的仓库）或 repoDir（已备好的任务根目录）`);
    }
    return {
      repo,
      machineId: machineIdValue,
      label: runnerLabel(machineIdValue),
      allowedActors: requireStringArray(item.allowedActors, `${at}.allowedActors`),
      sourceDir,
      repoDir,
      baseBranch: optionalString(item.baseBranch, `${at}.baseBranch`),
      worktreeDir: expandPath(
        optionalString(item.worktreeDir, `${at}.worktreeDir`) ?? join(workspaceDir, repo.replace('/', '-')),
        baseDir,
      ),
    };
  });

  const labelByRepo = new Map();
  for (const repo of repositories) {
    const previous = labelByRepo.get(repo.repo);
    if (previous !== undefined) fail(`仓库 ${repo.repo} 配置了多次；一台执行机对本仓库只用一条路由`);
    labelByRepo.set(repo.repo, repo.label);
  }

  return { runnerId, harness, github, runtime, repositories };
}

export function loadConfig({ configPath, machineId, home } = {}) {
  const path = resolve(configPath ?? DEFAULT_CONFIG_PATH);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(
      `读取配置失败 ${path}：${error.message}；可从仓库根的 config.example.json 复制一份再按本机修改`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`配置不是合法 JSON ${path}：${error.message}`);
  }
  return parseConfig(raw, { configPath: path, machineId, home });
}

/**
 * 启动前置校验：只核对本机路径存在与可执行。`gh` 的登录状态与目标仓库权限不在这里
 * 断言，由每次实际调用如实报错。
 */
export function checkConfig(config) {
  const problems = [];
  for (const [label, path] of [
    ['harness.bin', config.harness.bin],
    ['harness.patch', config.harness.patch],
  ]) {
    try {
      accessSync(path, constants.R_OK);
    } catch (error) {
      problems.push(`${label} 不可读（${path}）：${error.message}`);
    }
  }
  try {
    accessSync(config.harness.node, constants.X_OK);
  } catch (error) {
    problems.push(`harness.node 不可执行（${config.harness.node}）：${error.message}`);
  }
  for (const repo of config.repositories) {
    if (repo.sourceDir === undefined) continue;
    try {
      accessSync(repo.sourceDir, constants.R_OK);
    } catch (error) {
      problems.push(`sourceDir 不可读（${repo.repo} → ${repo.sourceDir}）：${error.message}`);
    }
  }
  return problems;
}
