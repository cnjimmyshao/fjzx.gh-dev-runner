// 测试入口：按文件名顺序加载全部 *.test.mjs。
//
// `node --test` 会为每个测试文件再起一个子进程；在不允许捕获子进程输出的受限环境里
// 那一步会失败。这里改为在同一进程内加载各测试文件，断言与用例组织不变，`npm test`
// 在受限环境与普通终端都能跑通。

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testDir = fileURLToPath(new URL('../test', import.meta.url));
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

for (const name of files) {
  await import(pathToFileURL(join(testDir, name)).href);
}
