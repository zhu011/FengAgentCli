#!/usr/bin/env bun
/**
 * scripts/build.ts — 跨平台二进制编译脚本
 *
 * 使用 `Bun.build({ compile: true })` 将 CLI 入口编译为独立可执行文件。
 * 生成的二进制文件无需 Bun 运行时即可运行。
 *
 * 用法：
 *   bun run build:binary                                    # 编译所有平台
 *   bun run build:binary -- --target=bun-windows-x64        # 仅编译指定平台
 *
 * 跨平台目标：
 *   - bun-windows-x64     → dist/fengagent-win-x64.exe
 *   - bun-linux-x64       → dist/fengagent-linux-x64
 *   - bun-darwin-arm64    → dist/fengagent-darwin-arm64
 *
 * 参考 docs/ARCHITECTURE.md 第 6.4 节编译方案。
 */

import { mkdir, rm, stat, rename } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const entry = resolve(root, "packages/cli/src/binary-entry.ts");
const distDir = resolve(root, "dist");

// 版本号与构建时间（通过 --define 注入到编译产物中）
const VERSION = "0.1.0";
const BUILD_TIME = new Date().toISOString();

// 所有跨平台编译目标
const ALL_TARGETS = [
  { target: "bun-windows-x64" as const, outfile: "fengagent-win-x64.exe" },
  { target: "bun-linux-x64" as const, outfile: "fengagent-linux-x64" },
  { target: "bun-darwin-arm64" as const, outfile: "fengagent-darwin-arm64" },
];

// 解析 --target 参数（允许只编译指定平台）
const cliArgs = process.argv.slice(2);
let targetFilter: string | undefined;
for (let i = 0; i < cliArgs.length; i++) {
  const arg = cliArgs[i]!;
  if (arg.startsWith("--target=")) {
    targetFilter = arg.slice("--target=".length);
  } else if (arg === "--target" && i + 1 < cliArgs.length) {
    targetFilter = cliArgs[++i];
  }
}

// --target=auto → 仅编译当前平台（npm pack / 快速构建用）
const AUTO_TARGET: Record<string, string> = {
  "win32-x64": "bun-windows-x64",
  "linux-x64": "bun-linux-x64",
  "darwin-arm64": "bun-darwin-arm64",
};
if (targetFilter === "auto") {
  targetFilter = AUTO_TARGET[`${process.platform}-${process.arch}`];
  if (!targetFilter) {
    console.error(
      `No auto target mapping for ${process.platform}-${process.arch}`,
    );
    process.exit(1);
  }
}

const targets = targetFilter
  ? ALL_TARGETS.filter((t) => t.target === targetFilter)
  : ALL_TARGETS;

if (targets.length === 0) {
  console.error(`No matching target for: ${targetFilter}`);
  console.error(`Available: ${ALL_TARGETS.map((t) => t.target).join(", ")}`);
  process.exit(1);
}

/**
 * Bun build plugin: 将 `react-devtools-core` 桩为一个空模块。
 *
 * `ink` 在其 devtools.js 中可选导入此包，它仅在开发模式下使用。
 * 编译二进制时不需要，用空模块替代以避免解析失败。
 */
const stubReactDevtools: import("bun").BunPlugin = {
  name: "stub-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default undefined;",
      loader: "js",
    }));
  },
};

// 清理并创建 dist 目录
console.log("Cleaning dist/...");
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

// 逐个编译
const built: string[] = [];
const failed: { target: string; error: string }[] = [];

for (const { target, outfile } of targets) {
  console.log(`\nBuilding ${target} → dist/${outfile}...`);

  try {
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: distDir,
      target,
      compile: true,
      minify: true,
      define: {
        "process.env.FENG_VERSION": JSON.stringify(VERSION),
        "process.env.FENG_BUILD_TIME": JSON.stringify(BUILD_TIME),
      },
      plugins: [stubReactDevtools],
    });

    if (!result.success) {
      const logs = result.logs.map(String).join("\n");
      throw new Error(logs);
    }

    // Bun.build compile 模式下输出文件名取自入口文件名
    // （binary-entry → binary-entry.exe），重命名为目标文件名
    const ext = target === "bun-windows-x64" ? ".exe" : "";
    const defaultOut = resolve(distDir, `binary-entry${ext}`);
    const targetOut = resolve(distDir, outfile);
    if (defaultOut !== targetOut) {
      await rename(defaultOut, targetOut);
    }

    const stats = await stat(targetOut);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    console.log(`  ✓ ${outfile} (${sizeMB} MB)`);
    built.push(outfile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${target}: ${message}`);
    failed.push({ target, error: message });
  }
}

// 汇总
console.log("");
if (built.length > 0) {
  console.log(`Built ${built.length} binary(ies):`);
  for (const f of built) {
    console.log(`  dist/${f}`);
  }
}

if (failed.length > 0) {
  console.error(`\n${failed.length} build(s) failed:`);
  for (const { target, error } of failed) {
    console.error(`  ${target}: ${error}`);
  }
  process.exit(1);
}

console.log("\n✓ All binaries built successfully.");
