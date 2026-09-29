/**
 * Runner 单实例保护：`<stateDir>/runner.lock` 用 `wx` 独占创建，避免 check→write 竞态。
 *
 * 陈旧锁（记录的 pid 已不存在）可被接管；锁内容读不出或 pid 不明确时拒绝抢占，
 * 交人工处理，而不是冒两个 Runner 同时写同一份状态的风险。
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class InstanceLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstanceLockError';
  }
}

/**
 * @param {string} stateDir
 * @param {{pid?: number, clock?: () => Date, isAlive?: (pid: number) => boolean}} [options]
 */
export function acquireInstanceLock(stateDir, options = {}) {
  const pid = options.pid ?? process.pid;
  const clock = options.clock ?? (() => new Date());
  const isAlive = options.isAlive ?? defaultIsAlive;
  const lockPath = path.join(stateDir, 'runner.lock');
  const nonce = randomBytes(8).toString('hex');
  const payload = `${JSON.stringify({ pid, startedAt: clock().toISOString(), nonce })}\n`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(handle, payload);
      fs.closeSync(handle);
      // 创建之后回读确认锁内容仍是自己的：并发接管同一个陈旧锁时，被抢走的一方必须在这里发现。
      if (fs.readFileSync(lockPath, 'utf8') !== payload) continue;
      return {
        path: lockPath,
        pid,
        /** 本进程是否仍是实例锁持有者；状态写入前用它复核。 */
        assertHeld() {
          let current;
          try {
            current = fs.readFileSync(lockPath, 'utf8');
          } catch {
            throw new InstanceLockError(`实例锁 ${lockPath} 已不存在，可能有其他 Runner 接管`);
          }
          if (current !== payload) {
            throw new InstanceLockError(`实例锁 ${lockPath} 已被其他进程接管，本进程停止写入状态`);
          }
        },
        release() {
          try {
            if (fs.readFileSync(lockPath, 'utf8') === payload) fs.unlinkSync(lockPath);
          } catch {
            /* 已删除、不可读或已被接管；不删除别人的锁 */
          }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new InstanceLockError(`无法创建实例锁 ${lockPath}: ${error.code ?? error.message}`);
      }
    }

    const observed = readLockText(lockPath);
    if (observed === null) {
      throw new InstanceLockError(`实例锁 ${lockPath} 内容不可读，拒绝抢占；请人工确认没有其他 Runner 在运行`);
    }
    const holder = parseLock(observed);
    if (holder === null) {
      throw new InstanceLockError(`实例锁 ${lockPath} 内容不可读，拒绝抢占；请人工确认没有其他 Runner 在运行`);
    }
    if (Number.isInteger(holder.pid) && isAlive(holder.pid)) {
      throw new InstanceLockError(`另一个 Runner 实例正在运行（pid ${holder.pid}），拒绝启动第二个实例`);
    }
    // 只删除仍然是我们刚才观察到的那一份陈旧锁；已被别人接管时不删，交由回读确认处理。
    if (readLockText(lockPath) !== observed) continue;
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new InstanceLockError(`无法清理陈旧实例锁 ${lockPath}: ${error.code ?? error.message}`);
      }
    }
  }
  throw new InstanceLockError(`实例锁 ${lockPath} 反复被占用，拒绝启动`);
}

/**
 * @param {string} lockPath
 * @returns {string|null}
 */
function readLockText(lockPath) {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {{pid?: number}|null}
 */
function parseLock(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {number} pid
 */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
