/** Runner 单实例保护：纯 wx 独占锁。存在锁就拒绝启动；不自动判断 stale、不接管。 */
import fs from 'node:fs';
import path from 'node:path';

export class InstanceLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstanceLockError';
  }
}

export function acquireInstanceLock(stateDir, options = {}) {
  const pid = options.pid ?? process.pid;
  const clock = options.clock ?? (() => new Date());
  const lockPath = path.join(stateDir, 'runner.lock');
  const payload = `${JSON.stringify({ pid, startedAt: clock().toISOString() })}\n`;
  let handle;
  try {
    handle = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(handle, payload);
  } catch (error) {
    if (handle !== undefined) try { fs.closeSync(handle); } catch {}
    if (error.code === 'EEXIST') {
      throw new InstanceLockError(`实例锁 ${lockPath} 已存在；拒绝自动接管。请先人工确认没有 Runner 在运行，再删除遗留锁`);
    }
    throw new InstanceLockError(`无法创建实例锁 ${lockPath}: ${error.code ?? error.message}`);
  }
  fs.closeSync(handle);
  return {
    path: lockPath,
    pid,
    release() {
      try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}
