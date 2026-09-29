#!/usr/bin/env node
/**
 * Research probe: run several `dsh --profile headless` processes against one
 * `DSH_HOME` at controlled start offsets, record the timeline, and optionally
 * test the session write lease from outside the Harness.
 *
 * It exists to reproduce the shared-`DSH_HOME` concurrency evidence in
 * `docs/research/2026-09-29-shared-dsh-home-concurrency.md`; it is not part of
 * the Runner.
 *
 * Usage:
 *   <node> shared-home-concurrency-probe.mjs <scenario.json>
 *
 * Scenario file (all paths absolute):
 *   {
 *     "dshBin":  "/path/to/@deepseek-ai/dsh/lib/bin.js",
 *     "dshHome": "/path/to/test/dsh-home",
 *     "outDir":  "/path/to/output",
 *     "processes": [
 *       { "label": "A", "cwd": "/path/workdir-a", "atMs": 0,
 *         "args": ["--profile", "headless", "--json", "task text"],
 *         "env": { "EXTRA": "1" }, "killAtMs": 5000 }
 *     ],
 *     "leaseChecks": [
 *       { "label": "holder-lock", "atMs": 5000, "lockPath": "/path/session.lock" }
 *     ]
 *   }
 *
 * Child processes receive a minimal environment (PATH, HOME, TMPDIR, LANG,
 * `DSH_HOME`, `DSH_TELEMETRY_DISABLED=1`) plus each process's own `env`, never
 * the probe's full environment: the live Harness exports `DSH_SESSION_ID`,
 * `DSH_PROFILE` and friends, which must not leak into a test run.
 *
 * Outputs into `outDir`: `<label>.stdout`, `<label>.stderr`, `report.json`.
 * The report holds only timeline facts, exit status, parsed `--json` run
 * events (session id, turn end reason, final text) and lease-check results.
 *
 * Exit status: 0 when every scheduled process was spawned (whatever it then
 * did, including being killed); 1 when any process failed to spawn, which is an
 * infrastructure failure rather than a scenario outcome. The report is written
 * in both cases.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const scenarioPath = process.argv[2];
if (scenarioPath === undefined) {
  console.error('usage: shared-home-concurrency-probe.mjs <scenario.json>');
  process.exit(2);
}

const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const outDir = resolve(scenario.outDir);
const dshHome = resolve(scenario.dshHome);
mkdirSync(outDir, { recursive: true });

/** Minimal child environment: OS basics plus the Harness home for this test. */
function childEnv(extra) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.DSH_HOME = dshHome;
  // Never send session prefixes to the telemetry endpoint from a test run.
  env.DSH_TELEMETRY_DISABLED = '1';
  return { ...env, ...(extra ?? {}) };
}

const now = () => Number(process.hrtime.bigint() / 1000000n);
const t0 = now();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const processes = [];
const leaseChecks = [];

function startProcess(spec) {
  const stdoutPath = join(outDir, `${spec.label}.stdout`);
  const stderrPath = join(outDir, `${spec.label}.stderr`);
  const outFd = openSync(stdoutPath, 'w');
  const errFd = openSync(stderrPath, 'w');
  const entry = {
    label: spec.label,
    cwd: resolve(spec.cwd),
    args: spec.args,
    scheduledAtMs: spec.atMs ?? 0,
    spawnAtMs: undefined,
    exitAtMs: undefined,
    exitCode: undefined,
    signal: undefined,
    spawnError: undefined,
    killedAtMs: undefined,
    stdoutPath,
    stderrPath,
  };
  processes.push(entry);
  const child = spawn(process.execPath, [resolve(scenario.dshBin), ...spec.args], {
    cwd: entry.cwd,
    env: childEnv(spec.env),
    stdio: ['ignore', outFd, errFd],
  });
  entry.spawnAtMs = now() - t0;
  entry.pid = child.pid;
  if (spec.killAtMs !== undefined) {
    // Simulate a hard crash while the process holds whatever it holds.
    setTimeout(() => {
      if (entry.exitAtMs === undefined) {
        entry.killedAtMs = now() - t0;
        child.kill('SIGKILL');
      }
    }, Math.max(0, spec.killAtMs - (now() - t0)));
  }
  entry.exited = new Promise((done) => {
    // A spawn failure (bad cwd, missing binary, resource limits) emits 'error'
    // and may never emit 'exit': settle on either, exactly once, so the report
    // is still written instead of the promise hanging.
    let settled = false;
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      entry.exitAtMs = now() - t0;
      entry.exitCode = code;
      entry.signal = signal;
      closeSync(outFd);
      closeSync(errFd);
      done();
    };
    child.on('exit', (code, signal) => settle(code, signal));
    child.on('error', (error) => {
      entry.spawnError = { code: error.code, message: error.message };
      entry.errorAtMs = now() - t0;
      settle(undefined, undefined);
    });
  });
}

/**
 * Try a non-blocking exclusive `flock` on a lock path from a separate process.
 * The Harness lease is a kernel lock, so this is independent evidence that the
 * lock is actually held, not just that a lock file exists.
 */
async function runLeaseCheck(spec) {
  const script = [
    'import fcntl, json, sys',
    'handle = open(sys.argv[1], "w")',
    'try:',
    '    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)',
    '    print(json.dumps({"acquired": True}))',
    'except OSError as error:',
    '    print(json.dumps({"acquired": False, "errno": error.errno}))',
  ].join('\n');
  const result = { label: spec.label, scheduledAtMs: spec.atMs, lockPath: resolve(spec.lockPath) };
  result.ranAtMs = now() - t0;
  const child = spawn('python3', ['-c', script, result.lockPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (err += chunk));
  await new Promise((done) => child.on('exit', (code) => {
    result.exitCode = code;
    result.stderr = err.trim() || undefined;
    try {
      Object.assign(result, JSON.parse(out.trim()));
    } catch {
      result.stdout = out.trim() || undefined;
    }
    done();
  }));
  leaseChecks.push(result);
}

/** Parse the `--json` run events that matter for the recorded outcome. */
function parseRunEvents(stdoutPath, args) {
  if (!args.includes('--json')) return undefined;
  let sessionId;
  let turnEndReason;
  let finalText;
  let toolCalls = 0;
  for (const line of readFileSync(stdoutPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'session') sessionId = event.sessionId;
    else if (event.type === 'final') finalText = event.text;
    else if (event.type === 'tool_call') toolCalls += 1;
    else if (event.type === 'status' && event.phase === 'turn_end') turnEndReason = event.reason;
  }
  return { sessionId, turnEndReason, finalText, toolCalls };
}

const schedule = [...(scenario.processes ?? [])].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
const checks = [...(scenario.leaseChecks ?? [])].sort((a, b) => a.atMs - b.atMs);
// One shared timeline: spawns and lease checks interleave in scheduled order,
// so a check scheduled while a process runs really runs inside that window.
const timeline = [
  ...schedule.map((spec) => ({ atMs: spec.atMs ?? 0, spawn: spec })),
  ...checks.map((spec) => ({ atMs: spec.atMs, leaseCheck: spec })),
].sort((a, b) => a.atMs - b.atMs);
let elapsed = 0;
for (const step of timeline) {
  if (step.atMs > elapsed) {
    await sleep(step.atMs - elapsed);
    elapsed = step.atMs;
  }
  if (step.spawn !== undefined) startProcess(step.spawn);
  else await runLeaseCheck(step.leaseCheck);
}
await Promise.all(processes.map((entry) => entry.exited));

for (const entry of processes) {
  entry.parsed = parseRunEvents(entry.stdoutPath, entry.args);
  delete entry.exited;
}

const report = {
  startedAt: new Date(Date.now() - (now() - t0)).toISOString(),
  durationMs: now() - t0,
  node: process.version,
  dshBin: resolve(scenario.dshBin),
  dshHome,
  processes,
  leaseChecks,
};
writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
for (const entry of processes) {
  console.log(
    `${entry.label}: exit=${entry.exitCode} spawn=${entry.spawnAtMs}ms exit=${entry.exitAtMs}ms ` +
      `session=${entry.parsed?.sessionId ?? '-'} turnEnd=${JSON.stringify(entry.parsed?.turnEndReason) ?? '-'}`,
  );
}
for (const check of leaseChecks) {
  console.log(`${check.label}: lease acquired=${check.acquired} at=${check.ranAtMs}ms`);
}
// A process that never started is an infrastructure failure, not a scenario
// outcome: keep the report, but exit non-zero so the caller notices.
const spawnFailures = processes.filter((entry) => entry.spawnError !== undefined);
for (const entry of spawnFailures) {
  console.log(`${entry.label}: SPAWN ERROR ${entry.spawnError.code}: ${entry.spawnError.message}`);
}
process.exitCode = spawnFailures.length === 0 ? 0 : 1;
