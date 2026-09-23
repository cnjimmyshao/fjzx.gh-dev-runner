import { strict as assert } from 'node:assert';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  checkConfig, ConfigError, expandPath, parseConfig, runnerLabel, validateRepoName, validateRunnerId,
} from '../src/config.mjs';

const BASE = {
  machineId: 'mb01',
  harness: { bin: 'C:/dsh/lib/bin.js', patch: 'scripts/headless-session/overlay.yml' },
  repositories: [{ repo: 'owner/project', allowedActors: ['maintainer'], repoDir: 'C:/tasks/project' }],
};

function parse(patch, options = {}) {
  return parseConfig({ ...BASE, ...patch }, { configPath: join('C:', 'cfg', 'config.json'), ...options });
}

test('缺省值补齐命令词、轮询间隔与子进程捕获方式', () => {
  const config = parse({});
  assert.equal(config.runnerId, 'mb01');
  assert.equal(config.github.command, '@dev');
  assert.equal(config.github.pageSize, 100);
  assert.equal(config.runtime.pollSeconds, 60);
  assert.equal(config.runtime.capture, undefined, 'capture 由入口按 --capture 决定');
  assert.equal(config.runtime.logMode, 'file');
  assert.equal(config.repositories[0].label, 'runner:mb01');
  assert.equal(runnerLabel('dev-a'), 'runner:dev-a');
});

test('执行机标识可来自命令行，配置里就不必重复写', () => {
  const raw = { ...BASE, machineId: undefined };
  const config = parseConfig(raw, { configPath: join('C:', 'cfg', 'config.json'), machineId: 'mb07' });
  assert.equal(config.runnerId, 'mb07');
  assert.equal(config.repositories[0].label, 'runner:mb07');
});

test('缺少执行机标识时明确失败', () => {
  assert.throws(() => parse({ machineId: undefined }), /缺少执行机标识/);
});

test('执行机标识与仓库名做启动期校验', () => {
  assert.throws(() => parse({ machineId: 'mb 01' }), ConfigError);
  assert.throws(() => validateRepoName('owner', 'repo'), /owner\/name/);
  assert.throws(() => validateRepoName('owner/name/extra', 'repo'), /owner\/name/);
  assert.throws(() => validateRunnerId('', 'machineId'), ConfigError);
  assert.equal(validateRepoName(' owner/project ', 'repo'), 'owner/project');
});

test('每个仓库必须有发起人许可与工作目录来源', () => {
  assert.throws(() => parse({ repositories: [{ repo: 'owner/project', repoDir: 'C:/x' }] }), /allowedActors/);
  assert.throws(() => parse({ repositories: [{ repo: 'owner/project', allowedActors: [] , repoDir: 'C:/x' }] }), /allowedActors/);
  assert.throws(
    () => parse({ repositories: [{ repo: 'owner/project', allowedActors: ['maintainer'] }] }),
    /sourceDir|repoDir/,
  );
  assert.throws(() => parse({ repositories: [] }), /repositories/);
  assert.throws(
    () => parse({
      repositories: [
        { repo: 'owner/project', allowedActors: ['a'], repoDir: 'C:/x' },
        { repo: 'owner/project', allowedActors: ['a'], repoDir: 'C:/y' },
      ],
    }),
    /配置了多次/,
  );
});

test('标签路由用的 machineId 可以按仓库覆盖，用于同机不同路由', () => {
  const config = parse({
    repositories: [
      { repo: 'owner/project', allowedActors: ['a'], repoDir: 'C:/x' },
      { repo: 'owner/other', allowedActors: ['a'], repoDir: 'C:/y', machineId: 'mb02' },
    ],
  });
  assert.deepEqual(config.repositories.map((item) => item.label), ['runner:mb01', 'runner:mb02']);
});

test('路径支持 ~ 与相对配置文件目录展开', () => {
  assert.equal(expandPath('~', 'C:/cfg'), homedir());
  assert.equal(expandPath('~/tasks', 'C:/cfg'), join(homedir(), 'tasks'));
  assert.equal(expandPath('rel/tasks', 'C:/cfg'), resolve('C:/cfg', 'rel/tasks'));
  const config = parse({
    harness: { ...BASE.harness, patch: 'scripts/x.yml' },
    runtime: { stateDir: '.local/state' },
  });
  assert.equal(config.harness.patch, resolve('C:/cfg', 'scripts/x.yml'));
  assert.equal(config.runtime.stateDir, resolve('C:/cfg', '.local/state'));
});

test('非法捕获方式与非整数间隔不进入运行期', () => {
  assert.throws(() => parse({ runtime: { logMode: 'socket' } }), /logMode/);
  assert.equal(parse({ runtime: { pollSeconds: -1 } }).runtime.pollSeconds, 60);
  assert.equal(parse({ github: { pageSize: 500 } }).github.pageSize, 100);
  assert.equal(parse({ github: { pageSize: 10 } }).github.pageSize, 10);
});

test('启动前置校验只核对本机路径，不承诺 gh 已登录', () => {
  const config = parse({});
  const problems = checkConfig(config);
  assert.equal(problems.length, 2, 'bin 与 patch 在测试里并不存在');
  assert.ok(problems.some((line) => line.includes('harness.bin')));
  assert.ok(problems.some((line) => line.includes('harness.patch')));
});
