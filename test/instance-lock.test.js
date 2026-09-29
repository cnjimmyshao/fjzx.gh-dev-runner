import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { InstanceLockError, acquireInstanceLock } from '../src/instance-lock.js';
import { cleanup, tempDir } from './helpers.js';

test('锁用 wx 独占创建；活锁存在时拒绝启动第二个实例', () => {
  const dir = tempDir();
  try {
    const first = acquireInstanceLock(dir, { pid: 111, isAlive: () => true });
    assert.ok(fs.existsSync(first.path));
    assert.throws(() => acquireInstanceLock(dir, { pid: 222, isAlive: () => true }), InstanceLockError);
    first.release();
    assert.equal(fs.existsSync(first.path), false);
  } finally {
    cleanup(dir);
  }
});

test('陈旧锁（进程已不存在）可以被接管', () => {
  const dir = tempDir();
  try {
    const first = acquireInstanceLock(dir, { pid: 111, isAlive: () => true });
    const second = acquireInstanceLock(dir, { pid: 222, isAlive: (pid) => pid !== 111 });
    assert.equal(JSON.parse(fs.readFileSync(second.path, 'utf8')).pid, 222);
    // 旧实例退出时不得删掉新实例的锁
    first.release();
    assert.equal(fs.existsSync(second.path), true);
    second.release();
    assert.equal(fs.existsSync(second.path), false);
  } finally {
    cleanup(dir);
  }
});

test('锁内容不可读时拒绝抢占', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'runner.lock'), 'garbage');
    assert.throws(() => acquireInstanceLock(dir, { pid: 1, isAlive: () => false }), InstanceLockError);
    assert.equal(fs.readFileSync(path.join(dir, 'runner.lock'), 'utf8'), 'garbage');
  } finally {
    cleanup(dir);
  }
});

test('真实进程存活判断：当前进程活着，几乎不可能存在的 pid 视为已退出', () => {
  const dir = tempDir();
  try {
    const lock = acquireInstanceLock(dir);
    assert.throws(() => acquireInstanceLock(dir), InstanceLockError);
    lock.release();
  } finally {
    cleanup(dir);
  }
});
