import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireInstanceLock, InstanceLockError } from '../src/instance-lock.js';

test('wx 实例锁：同一 stateDir 第二个 Runner 直接拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-lock-'));
  const first = acquireInstanceLock(dir, { pid: 101, clock: () => new Date('2026-01-01T00:00:00Z') });
  assert.throws(() => acquireInstanceLock(dir, { pid: 102 }), InstanceLockError);
  first.release();
  const second = acquireInstanceLock(dir, { pid: 102 });
  second.release();
});

test('遗留锁不自动接管，需人工确认后删除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-lock-'));
  const lockPath = path.join(dir, 'runner.lock');
  fs.writeFileSync(lockPath, '{"pid":999}\n', { mode: 0o600 });
  assert.throws(() => acquireInstanceLock(dir, { pid: 103 }), /拒绝自动接管/);
  fs.unlinkSync(lockPath);
  const lock = acquireInstanceLock(dir, { pid: 103 });
  lock.release();
});
