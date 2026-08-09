/**
 * @fengagent/cli — 编译二进制入口
 *
 * 此文件仅用于 `bun build --compile` 编译场景。
 * 在编译模式下 `import.meta.main` 对被引用的模块不可靠，
 * 因此使用此包装入口显式调用 `main()`。
 *
 * 源码运行时直接使用 `entry.ts`（它通过 `import.meta.main` 自动启动）。
 */

import { main } from "./entry.ts";

const argv = process.argv.slice(2);
main(argv).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal: ${message}\n`);
  process.exit(1);
});
