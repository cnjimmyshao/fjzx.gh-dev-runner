/**
 * Runner 人工部署配置的加载与校验。
 *
 * 唯一部署入口是 `.env`（见 docs/current/04-local-state.md）。本模块只做语法与语义校验，
 * 不访问 GitHub、不读取模型凭据、也不检查文件系统（环境检查见 `checkEnvironment`）。
 */

import fs from 'node:fs';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_POLL_SECONDS = 300;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_GH_TIMEOUT_MS = 60_000;
const DEFAULT_GH_PAGE_SIZE = 50;
const DEFAULT_GH_MAX_PAGES = 10;
const DEFAULT_KEEP_RUN_LOGS = 20;
const DEFAULT_CAPTURE = 'metadata';
const DEFAULT_PROFILE = 'headless';
const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_GIT_BIN = 'git';
const CAPTURE_MODES = new Set(['metadata', 'full']);

/**
 * Runner 自身认识的全部配置键。`.env` 是人工部署的规范入口；同名进程环境变量可以覆盖
 * 取值（便于一次性验证），但不认识的变量不会被当成 Runner 配置。
 */
export const CONFIG_KEYS = Object.freeze([
  'RUNNER_NAME',
  'STATE_DIR',
  'WORK_ROOT',
  'DSH_BIN',
  'DSH_PROFILE',
  'DSH_HOME',
  'HARNESS_TIMEOUT_MS',
  'HARNESS_ENV_ALLOWLIST',
  'POLL_SECONDS',
  'MAX_CONCURRENT_HARNESSES',
  'CAPTURE',
  'KEEP_RUN_LOGS',
  'GH_TIMEOUT_MS',
  'GH_PAGE_SIZE',
  'GH_MAX_PAGES',
  'GIT_BIN',
  'REPOSITORIES_JSON',
]);

/**
 * 解析 `.env` 文本。只支持 `KEY=VALUE`；忽略空行与 `#` 注释，允许成对的引号。
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      throw new ConfigError(`无法解析的 .env 行: ${rawLine}`);
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ConfigError(`非法的 .env 变量名: ${key}`);
    }
    values[key] = value;
  }
  return values;
}

/**
 * 读取并校验 Runner 配置。
 * @param {object} [options]
 * @param {string} [options.envFile] `.env` 路径；默认 `<cwd>/.env`。
 * @param {Record<string, string|undefined>} [options.env] 进程环境，用于覆盖 `.env` 中的同名键。
 * @param {string} [options.cwd]
 * @returns {object} 规范化配置
 */
export function loadConfig(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const envFile = path.resolve(cwd, options.envFile ?? '.env');
  const fileValues = readEnvFile(envFile);
  const overlay = options.env ?? process.env;

  const raw = { ...fileValues };
  for (const key of CONFIG_KEYS) {
    const value = overlay[key];
    if (value !== undefined && value !== '') raw[key] = value;
  }

  return normalizeConfig(raw, { cwd, envFile });
}

/**
 * @param {string} envFile
 * @returns {Record<string, string>}
 */
function readEnvFile(envFile) {
  if (!fs.existsSync(envFile)) return {};
  const stat = fs.statSync(envFile);
  if (!stat.isFile()) throw new ConfigError(`配置入口不是普通文件: ${envFile}`);
  return parseEnvText(fs.readFileSync(envFile, 'utf8'));
}

/**
 * @param {Record<string, string>} raw
 * @param {{cwd: string, envFile: string}} context
 */
function normalizeConfig(raw, context) {
  const runnerName = requireString(raw, 'RUNNER_NAME');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runnerName)) {
    throw new ConfigError('RUNNER_NAME 只能包含字母、数字、点、下划线与连字符，且需以字母或数字开头');
  }

  const stateDir = resolvePath(requireString(raw, 'STATE_DIR'), context.cwd, 'STATE_DIR');
  const workspaceDir = optionalString(raw, 'WORK_ROOT')
    ? resolvePath(optionalString(raw, 'WORK_ROOT'), context.cwd, 'WORK_ROOT')
    : null;

  const harnessBinRaw = requireString(raw, 'DSH_BIN');
  const profile = optionalString(raw, 'DSH_PROFILE') ?? DEFAULT_PROFILE;
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new ConfigError('DSH_PROFILE 只能包含字母、数字、点、下划线与连字符');
  }

  const repositories = parseRepositories(raw.REPOSITORIES_JSON, {
    cwd: context.cwd,
    workspaceDir,
  });

  return {
    envFile: context.envFile,
    cwd: context.cwd,
    runnerName,
    harness: {
      bin: resolveExecutableReference(harnessBinRaw, context.cwd),
      profile,
      home: optionalString(raw, 'DSH_HOME')
        ? resolvePath(optionalString(raw, 'DSH_HOME'), context.cwd, 'DSH_HOME')
        : null,
      timeoutMs: nonNegativeInt(raw, 'HARNESS_TIMEOUT_MS', 0),
      envAllowlist: parseAllowlist(raw.HARNESS_ENV_ALLOWLIST),
    },
    runtime: {
      stateDir,
      workspaceDir,
      pollSeconds: positiveInt(raw, 'POLL_SECONDS', DEFAULT_POLL_SECONDS),
      maxConcurrentHarnesses: positiveInt(raw, 'MAX_CONCURRENT_HARNESSES', DEFAULT_MAX_CONCURRENT),
      capture: captureMode(raw.CAPTURE),
      keepRunLogs: positiveInt(raw, 'KEEP_RUN_LOGS', DEFAULT_KEEP_RUN_LOGS),
    },
    github: {
      timeoutMs: positiveInt(raw, 'GH_TIMEOUT_MS', DEFAULT_GH_TIMEOUT_MS),
      pageSize: boundedInt(raw, 'GH_PAGE_SIZE', DEFAULT_GH_PAGE_SIZE, 1, 100),
      maxPages: boundedInt(raw, 'GH_MAX_PAGES', DEFAULT_GH_MAX_PAGES, 1, 100),
    },
    gitBin: optionalString(raw, 'GIT_BIN') ?? DEFAULT_GIT_BIN,
    repositories,
  };
}

/**
 * 解析 `REPOSITORIES_JSON`；每个仓库保留自己的 `allowedActors` 关联，不拆成全局列表。
 * @param {string|undefined} value
 * @param {{cwd: string, workspaceDir: string|null}} context
 */
function parseRepositories(value, context) {
  const text = requireString({ REPOSITORIES_JSON: value }, 'REPOSITORIES_JSON');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`REPOSITORIES_JSON 不是合法 JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigError('REPOSITORIES_JSON 必须是非空数组');
  }

  const seen = new Set();
  const worktreeDirs = new Map();
  return parsed.map((entry, index) => {
    const where = `REPOSITORIES_JSON[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConfigError(`${where} 必须是对象`);
    }
    const repo = entry.repo;
    if (typeof repo !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
      throw new ConfigError(`${where}.repo 必须是 "owner/name" 形式`);
    }
    if (seen.has(repo.toLowerCase())) {
      throw new ConfigError(`${where}.repo 重复: ${repo}`);
    }
    seen.add(repo.toLowerCase());

    const allowedActors = entry.allowedActors;
    if (!Array.isArray(allowedActors) || allowedActors.length === 0) {
      throw new ConfigError(`${where}.allowedActors 必须是非空数组`);
    }
    for (const actor of allowedActors) {
      if (typeof actor !== 'string' || actor.trim() === '') {
        throw new ConfigError(`${where}.allowedActors 只能包含非空字符串`);
      }
    }

    if (typeof entry.sourceDir !== 'string' || entry.sourceDir.trim() === '') {
      throw new ConfigError(`${where}.sourceDir 必须是已有仓库检出的路径`);
    }

    let worktreeDir = null;
    if (entry.worktreeDir !== undefined && entry.worktreeDir !== null) {
      if (typeof entry.worktreeDir !== 'string' || entry.worktreeDir.trim() === '') {
        throw new ConfigError(`${where}.worktreeDir 必须是非空字符串`);
      }
      worktreeDir = resolvePath(entry.worktreeDir, context.cwd, `${where}.worktreeDir`);
    } else if (context.workspaceDir !== null) {
      worktreeDir = path.join(context.workspaceDir, repoSlug(repo));
    } else {
      throw new ConfigError(`${where} 未提供 worktreeDir，且未配置 WORK_ROOT`);
    }

    const previous = worktreeDirs.get(worktreeDir);
    if (previous !== undefined) {
      throw new ConfigError(`${where}.worktreeDir 与 ${previous} 相同；同一父目录会让不同仓库的 issue-<n> 目录碰撞`);
    }
    worktreeDirs.set(worktreeDir, `${where}.repo=${repo}`);

    return {
      repo,
      allowedActors: allowedActors.map((actor) => String(actor).trim()),
      sourceDir: resolvePath(entry.sourceDir, context.cwd, `${where}.sourceDir`),
      baseBranch: typeof entry.baseBranch === 'string' && entry.baseBranch.trim() !== ''
        ? entry.baseBranch.trim()
        : DEFAULT_BASE_BRANCH,
      worktreeDir,
      maxConcurrentHarnesses: positiveRepoInt(entry.maxConcurrentHarnesses, `${where}.maxConcurrentHarnesses`),
    };
  });
}

/**
 * 启动时的环境检查：路径、Node 版本与 `gh` 认证。返回诊断信息供日志记录。
 * @param {object} config
 * @param {{execFileSync?: Function, nodeVersion?: string}} [deps]
 */
export function checkEnvironment(config, deps = {}) {
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  if (nodeVersion.split('.')[0] !== '24') {
    throw new ConfigError(
      `V1 正式运行版本为 Node.js 24 LTS，当前为 v${nodeVersion}；请用 Node 24 启动 Runner`,
    );
  }

  if (!fs.existsSync(config.harness.bin)) {
    throw new ConfigError(`DSH_BIN 不存在: ${config.harness.bin}`);
  }

  for (const repository of config.repositories) {
    const stat = statOrNull(repository.sourceDir);
    if (stat === null || !stat.isDirectory()) {
      throw new ConfigError(`repositories[].sourceDir 不存在或不是目录: ${repository.repo}`);
    }
  }

  ensureDirectory(config.runtime.stateDir, 'STATE_DIR');
  for (const repository of config.repositories) {
    ensureDirectory(repository.worktreeDir, `repositories[${repository.repo}].worktreeDir`);
  }
  if (config.harness.home !== null && !fs.existsSync(config.harness.home)) {
    throw new ConfigError(`DSH_HOME 不存在: ${config.harness.home}`);
  }
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function ensureDirectory(target, label) {
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (error) {
    throw new ConfigError(`${label} 无法创建: ${error.code ?? error.message}`);
  }
  if (!fs.statSync(target).isDirectory()) {
    throw new ConfigError(`${label} 不是目录: ${target}`);
  }
}

/**
 * 任务工作目录名的稳定派生：owner/name -> owner__name，避免不同仓库拼接后碰撞。
 * @param {string} repo
 */
export function repoSlug(repo) {
  return repo.replace('/', '__');
}

function requireString(raw, key) {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`缺少必填配置 ${key}`);
  }
  return value.trim();
}

function optionalString(raw, key) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function resolvePath(value, cwd, label) {
  if (value.includes('\0')) throw new ConfigError(`${label} 含非法字符`);
  return path.resolve(cwd, value);
}

function resolveExecutableReference(value, cwd) {
  // 允许直接写命令名（走 PATH）或写路径；路径按运行目录解析。
  return value.includes('/') ? path.resolve(cwd, value) : value;
}

function positiveInt(raw, key, fallback) {
  const value = optionalString(raw, key);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new ConfigError(`${key} 必须是正整数`);
  }
  return Number(value);
}

function nonNegativeInt(raw, key, fallback) {
  const value = optionalString(raw, key);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${key} 必须是非负整数`);
  }
  return Number(value);
}

function boundedInt(raw, key, fallback, min, max) {
  const value = optionalString(raw, key);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new ConfigError(`${key} 必须是 ${min}–${max} 之间的整数`);
  }
  return Number(value);
}

function positiveRepoInt(value, label) {
  if (value === undefined || value === null) return DEFAULT_MAX_CONCURRENT;
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${label} 必须是正整数`);
  }
  return value;
}

function captureMode(value) {
  const mode = optionalString({ CAPTURE: value }, 'CAPTURE') ?? DEFAULT_CAPTURE;
  if (!CAPTURE_MODES.has(mode)) {
    throw new ConfigError(`CAPTURE 只能是 ${[...CAPTURE_MODES].join(' 或 ')}`);
  }
  return mode;
}

function parseAllowlist(value) {
  const text = optionalString({ HARNESS_ENV_ALLOWLIST: value }, 'HARNESS_ENV_ALLOWLIST');
  if (text === null) return [];
  const names = text.split(',').map((name) => name.trim()).filter((name) => name !== '');
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ConfigError(`HARNESS_ENV_ALLOWLIST 含非法变量名: ${name}`);
    }
  }
  return names;
}
