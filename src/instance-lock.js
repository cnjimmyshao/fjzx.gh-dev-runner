/**
 * Runner 单实例保护：`<stateDir>/runner.lock` 用 `wx` 独占创建，避免 check→write 竞态。
 *
 * 陈旧锁（记录的 pid 已不存在）可被接管；锁内容读不出或 pid 不明确时拒绝抢占，
 * 交人工处理，而不是冒两个 Runner 同时写同一份状态的风险。
 */

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

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(handle, `${JSON.stringify({ pid, startedAt: clock().toISOString() })}\n`);
      fs.closeSync(handle);
      return {
        path: lockPath,
        pid,
        release() {
          try {
            const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (content?.pid === pid) fs.unlinkSync(lockPath);
          } catch {
            /* 已删除或内容不可读；不删除别人的锁 */
          }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new InstanceLockError(`无法创建实例锁 ${lockPath}: ${error.code ?? error.message}`);
      }
    }

    const holder = readLock(lockPath);
    if (holder === null) {
      throw new InstanceLockError(`实例锁 ${lockPath} 内容不可读，拒绝抢占；请人工确认没有其他 Runner 在运行`);
    }
    if (Number.isInteger(holder.pid) && isAlive(holder.pid)) {
      throw new InstanceLockError(`另一个 Runner 实例正在运行（pid ${holder.pid}），拒绝启动第二个实例`);
    }
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
 * @returns {{pid?: number}|null}
 */
function readLock(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
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
