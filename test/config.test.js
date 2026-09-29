import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ConfigError, checkEnvironment, loadConfig, parseEnvText, repoSlug } from '../src/config.js';
import { cleanup, tempDir } from './helpers.js';

test('parseEnvText 忽略注释与空行，支持成对引号', () => {
  const values = parseEnvText(['# comment', '', 'A=1', 'B="two words"', "C='x'", 'D=a=b'].join('\n'));
  assert.deepEqual(values, { A: '1', B: 'two words', C: 'x', D: 'a=b' });
});

test('parseEnvText 拒绝无法解析的行', () => {
  assert.throws(() => parseEnvText('JUSTAWORD'), ConfigError);
});

test('loadConfig 读取 .env，进程环境覆盖同名键', () => {
  const dir = tempDir();
  try {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(
      envFile,
      [
        'RUNNER_NAME=MB01',
        `STATE_DIR=${path.join(dir, 'state')}`,
        'DSH_BIN=/bin/echo',
        `REPOSITORIES_JSON=${JSON.stringify([
          { repo: 'owner/repo-a', allowedActors: ['alice'], sourceDir: dir, worktreeDir: path.join(dir, 'wt') },
        ])}`,
      ].join('\n'),
    );
    const config = loadConfig({ envFile, env: { RUNNER_NAME: 'HZ01' }, cwd: dir });
    assert.equal(config.runnerName, 'HZ01');
    assert.equal(config.runtime.pollSeconds, 300);
    assert.equal(config.runtime.maxConcurrentHarnesses, 1);
    assert.equal(config.harness.profile, 'headless');
    assert.equal(config.runtime.capture, 'metadata');
    assert.equal(config.repositories[0].worktreeDir, path.join(dir, 'wt'));
    assert.equal(config.repositories[0].baseBranch, 'main');
  } finally {
    cleanup(dir);
  }
});

test('loadConfig 保留 repo 与 allowedActors 的对应关系，并拒绝重复仓库', () => {
  const dir = tempDir();
  try {
    const raw = {
      RUNNER_NAME: 'MB01',
      STATE_DIR: path.join(dir, 'state'),
      WORK_ROOT: path.join(dir, 'work'),
      DSH_BIN: '/bin/echo',
      REPOSITORIES_JSON: JSON.stringify([
        { repo: 'owner/a', allowedActors: ['alice'], sourceDir: dir },
        { repo: 'owner/b', allowedActors: ['bob'], sourceDir: dir, maxConcurrentHarnesses: 2 },
      ]),
    };
    const config = loadConfig({ env: raw, cwd: dir, envFile: path.join(dir, 'missing.env') });
    assert.deepEqual(config.repositories.map((repo) => repo.repo), ['owner/a', 'owner/b']);
    assert.deepEqual(config.repositories[0].allowedActors, ['alice']);
    assert.deepEqual(config.repositories[1].allowedActors, ['bob']);
    assert.equal(config.repositories[1].maxConcurrentHarnesses, 2);
    assert.equal(config.repositories[0].maxConcurrentHarnesses, 1);

    assert.throws(
      () =>
        loadConfig({
          env: { ...raw, REPOSITORIES_JSON: JSON.stringify([
            { repo: 'owner/a', allowedActors: ['alice'], sourceDir: dir },
            { repo: 'owner/a', allowedActors: ['bob'], sourceDir: dir },
          ]) },
          cwd: dir,
          envFile: path.join(dir, 'missing.env'),
        }),
      /重复/,
    );
  } finally {
    cleanup(dir);
  }
});

test('loadConfig 拒绝非法取值', () => {
  const dir = tempDir();
  const base = {
    RUNNER_NAME: 'MB01',
    STATE_DIR: path.join(dir, 'state'),
    DSH_BIN: '/bin/echo',
    REPOSITORIES_JSON: JSON.stringify([{ repo: 'owner/a', allowedActors: ['alice'], sourceDir: dir }]),
  };
  const load = (overrides) =>
    loadConfig({ env: { ...base, ...overrides }, cwd: dir, envFile: path.join(dir, 'missing.env') });

  assert.throws(() => load({ RUNNER_NAME: 'bad name' }), ConfigError);
  assert.throws(() => load({ POLL_SECONDS: '0' }), ConfigError);
  assert.throws(() => load({ POLL_SECONDS: 'abc' }), ConfigError);
  assert.throws(() => load({ MAX_CONCURRENT_HARNESSES: '-1' }), ConfigError);
  assert.throws(() => load({ CAPTURE: 'everything' }), ConfigError);
  assert.throws(() => load({ HARNESS_ENV_ALLOWLIST: '1BAD' }), ConfigError);
  assert.throws(() => load({ REPOSITORIES_JSON: 'not json' }), ConfigError);
  assert.throws(() => load({ REPOSITORIES_JSON: '[]' }), ConfigError);
  assert.throws(
    () => load({ REPOSITORIES_JSON: JSON.stringify([{ repo: 'owner/a', allowedActors: [], sourceDir: dir }]) }),
    /allowedActors/,
  );
  assert.throws(
    () => load({ REPOSITORIES_JSON: JSON.stringify([{ repo: 'owner/a', allowedActors: ['alice'] }]) }),
    /sourceDir/,
  );
  assert.throws(() => load({ DSH_BIN: '' }), ConfigError);
});

test('checkEnvironment 要求 Node 24、存在的入口与源仓库目录', () => {
  const dir = tempDir();
  try {
    const config = loadConfig({
      env: {
        RUNNER_NAME: 'MB01',
        STATE_DIR: path.join(dir, 'state'),
        DSH_BIN: '/bin/echo',
        REPOSITORIES_JSON: JSON.stringify([
          { repo: 'owner/a', allowedActors: ['alice'], sourceDir: dir, worktreeDir: path.join(dir, 'wt') },
        ]),
      },
      cwd: dir,
      envFile: path.join(dir, 'missing.env'),
    });
    assert.throws(() => checkEnvironment(config, { nodeVersion: '26.8.1' }), /Node\.js 24/);
    checkEnvironment(config, { nodeVersion: '24.16.0' });
    assert.ok(fs.existsSync(config.runtime.stateDir));

    const broken = loadConfig({
      env: {
        RUNNER_NAME: 'MB01',
        STATE_DIR: path.join(dir, 'state2'),
        DSH_BIN: '/bin/echo',
        REPOSITORIES_JSON: JSON.stringify([
          {
            repo: 'owner/a',
            allowedActors: ['alice'],
            sourceDir: path.join(dir, 'missing-src'),
            worktreeDir: path.join(dir, 'wt2'),
          },
        ]),
      },
      cwd: dir,
      envFile: path.join(dir, 'missing.env'),
    });
    assert.throws(() => checkEnvironment(broken, { nodeVersion: '24.16.0' }), /sourceDir/);
  } finally {
    cleanup(dir);
  }
});

test('repoSlug 不会让不同仓库的目录碰撞', () => {
  assert.notEqual(repoSlug('acme/foo-bar'), repoSlug('acme-foo/bar'));
});
