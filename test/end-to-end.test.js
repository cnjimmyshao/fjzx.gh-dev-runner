import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { cleanup, tempDir } from './helpers.js';

const run = promisify(execFile);

function resolveGitBin() {
  const candidates = [process.env.FJZX_TEST_GIT_BIN, 'git', '/opt/homebrew/bin/git', '/usr/bin/git'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

const gitBin = resolveGitBin();

/**
 * 端到端边界测试：真实配置加载、真实 state/audit 写入、真实 git worktree、真实子进程 spawn，
 * 只有 GitHub 与 Harness 用本机替身（替身不代写 Runner 自己负责的输出）。
 */
test('端到端：baseline → 评论触发 → worktree → Harness → 接单确认', { skip: gitBin === null && '本机没有可用的 git' }, async () => {
  const root = tempDir('fjzx-e2e-');
  const fakeBin = path.join(root, 'bin');
  const stateDir = path.join(root, 'state');
  const worktreeDir = path.join(root, 'worktrees');
  const sourceDir = path.join(root, 'source');
  const fixtures = path.join(root, 'fixtures');
  const commentsLog = path.join(root, 'gh-comments.log');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(fixtures, { recursive: true });
  fs.mkdirSync(sourceDir, { recursive: true });

  try {
    // 源仓库
    execFileSync(gitBin, ['init', '-b', 'main'], { cwd: sourceDir, stdio: 'ignore' });
    execFileSync(gitBin, ['config', 'user.email', 'test@example.com'], { cwd: sourceDir });
    execFileSync(gitBin, ['config', 'user.name', 'Test'], { cwd: sourceDir });
    fs.writeFileSync(path.join(sourceDir, 'README.md'), '# demo\n');
    execFileSync(gitBin, ['add', '.'], { cwd: sourceDir });
    execFileSync(gitBin, ['commit', '-m', 'init'], { cwd: sourceDir, stdio: 'ignore' });

    // GitHub 替身：按 Issues / Comments API 的语义（含 since 过滤与分页）返回 fixture，
    // `gh issue comment` 把 stdin 落到本地文件。替身不写 Runner 自己的任何输出。
    const issue = {
      number: 7,
      body: '实现这件事',
      user: { login: 'alice' },
      comments: 1,
      updated_at: new Date(Date.now() - 3_600_000).toISOString(),
    };
    const oldComment = {
      id: 100,
      body: '历史讨论',
      user: { login: 'alice' },
      created_at: new Date(Date.now() - 3_600_000).toISOString(),
      updated_at: new Date(Date.now() - 3_600_000).toISOString(),
    };
    const newComment = {
      id: 200,
      body: '请开始处理。\n\n@MB01',
      user: { login: 'alice' },
      // 相对 baseline 的扫描边界而言“刚发布”：出现在水位之后
      created_at: new Date(Date.now() + 1_000).toISOString(),
      updated_at: new Date(Date.now() + 1_000).toISOString(),
    };
    const fixturesFile = path.join(fixtures, 'fixtures.json');
    const writeFixtures = (comments, issuePatch = {}) =>
      fs.writeFileSync(fixturesFile, JSON.stringify({ issue: { ...issue, ...issuePatch }, comments }));
    // baseline 时仓库里只有历史评论与旧更新时间
    writeFixtures([oldComment]);
    fs.writeFileSync(
      path.join(fakeBin, 'fake-gh.mjs'),
      `import fs from 'node:fs';
const { issue, comments } = JSON.parse(fs.readFileSync(${JSON.stringify(fixturesFile)}, 'utf8'));
const args = process.argv.slice(2);
const respond = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (args[0] === 'auth') respond('');
if (args[0] === 'issue' && args[1] === 'comment') {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  fs.appendFileSync(${JSON.stringify(commentsLog)}, Buffer.concat(chunks).toString('utf8') + '\\n===END===\\n');
  respond('');
}
const endpoint = args[args.length - 1];
const url = new URL('http://localhost/' + endpoint);
const since = url.searchParams.get('since');
const sinceMs = since === null ? null : Date.parse(since);
const pageSize = Number(url.searchParams.get('per_page') ?? 30);
const page = Number(url.searchParams.get('page') ?? 1);
const paginate = (items) => items.slice((page - 1) * pageSize, page * pageSize);
if (endpoint.startsWith('repos/owner/repo/issues/7/comments')) {
  const fresh = sinceMs === null ? comments : comments.filter((c) => Date.parse(c.updated_at) >= sinceMs);
  respond(paginate(fresh));
}
if (endpoint === 'repos/owner/repo/issues/7') respond(issue);
if (endpoint.startsWith('repos/owner/repo/issues')) {
  const fresh = sinceMs === null || Date.parse(issue.updated_at) >= sinceMs ? [issue] : [];
  respond(paginate(fresh));
}
process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
process.exit(1);
`,
    );
    fs.writeFileSync(
      path.join(fakeBin, 'gh'),
      `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(fakeBin, 'fake-gh.mjs'))} "$@"
`,
      { mode: 0o755 },
    );

    // Harness 替身：走真实子进程与 --json 事件流协议
    const harness = path.join(root, 'fake-harness.mjs');
    fs.writeFileSync(
      harness,
      `const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
emit({ type: 'session', sessionId: 'session-e2e', cwd: process.cwd() });
emit({ type: 'status', phase: 'turn_start', turn: 1 });
emit({ type: 'text', text: 'working' });
emit({ type: 'status', phase: 'turn_end', turn: 1, reason: 'completed' });
emit({ type: 'final', text: 'done' });
process.exit(0);
`,
    );

    const envFile = path.join(root, '.env');
    fs.writeFileSync(
      envFile,
      [
        'RUNNER_NAME=MB01',
        `STATE_DIR=${stateDir}`,
        `DSH_BIN=${harness}`,
        `GIT_BIN=${gitBin}`,
        'GH_TIMEOUT_MS=10000',
        `REPOSITORIES_JSON=${JSON.stringify([
          {
            repo: 'owner/repo',
            allowedActors: ['alice'],
            sourceDir,
            baseBranch: 'main',
            worktreeDir,
            maxConcurrentHarnesses: 1,
          },
        ])}`,
      ].join('\n'),
    );

    const entry = path.resolve(import.meta.dirname, '..', 'src', 'index.js');
    const childEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
    const runOnce = () => run(process.execPath, [entry, '--env', envFile, '--once'], { env: childEnv });

    // 第一个 cycle：只做 baseline，不接单
    const first = await runOnce();
    assert.equal(first.stderr.trim(), '');
    const afterBaseline = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    assert.equal(afterBaseline.repositories['owner/repo'].baselineCompleted, true);
    assert.equal(afterBaseline.repositories['owner/repo'].issues['7'].commentScanWatermark, '100');
    assert.equal(Object.keys(afterBaseline.activeRuns).length, 0);
    assert.equal(fs.existsSync(commentsLog), false);

    // 之后有人在 Issue 上发布了新的控制评论
    writeFixtures([oldComment, newComment], {
      comments: 2,
      updated_at: new Date(Date.now() + 1_000).toISOString(),
    });

    // 第二个 cycle：扫描水位之后的新评论并领取
    const second = await run(process.execPath, [entry, '--env', envFile, '--once', '--wait'], { env: childEnv });
    assert.equal(second.stderr.trim(), '');

    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    const issueRecord = state.repositories['owner/repo'].issues['7'];
    assert.equal(issueRecord.lastTrigger.sourceType, 'comment');
    assert.equal(issueRecord.lastTrigger.sourceId, '200');
    assert.equal(issueRecord.commentScanWatermark, '200');
    assert.equal(issueRecord.binding.sessionId, 'session-e2e');
    assert.equal(issueRecord.binding.dir, path.join(worktreeDir, 'issue-7'));
    assert.equal(issueRecord.binding.worktreeCreated, true);
    assert.equal(issueRecord.lastRun.outcome, 'turn_completed');
    assert.equal(issueRecord.lastRun.exitCode, 0);

    const activeRuns = Object.values(state.activeRuns);
    assert.equal(activeRuns.length, 1);
    assert.equal(activeRuns[0].status, 'exited');
    assert.equal(activeRuns[0].feedback.success, true);

    // 真实 git worktree 与分支
    const branch = execFileSync(gitBin, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: path.join(worktreeDir, 'issue-7'),
      encoding: 'utf8',
    }).trim();
    assert.equal(branch, 'fjzx/issue-7');

    // 唯一的公开回写是接单确认，且不含本机路径
    const posted = fs.readFileSync(commentsLog, 'utf8');
    assert.match(posted, /BOT:MB01\nMB01 已接单，Session ID: session-e2e/);
    assert.doesNotMatch(posted, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // 本机 audit 覆盖一次完整运行
    const audit = fs
      .readFileSync(path.join(stateDir, 'audit', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const events = audit.map((record) => record.event);
    assert.ok(events.includes('baseline_completed'));
    assert.ok(events.includes('trigger_claimed'));
    assert.ok(events.includes('harness_spawned'));
    assert.ok(events.includes('session_bound'));
    assert.ok(events.includes('run_end'));

    // 已经越过水位的评论不会重放
    fs.rmSync(commentsLog);
    await runOnce();
    assert.equal(fs.existsSync(commentsLog), false);
  } finally {
    cleanup(root);
  }
});
