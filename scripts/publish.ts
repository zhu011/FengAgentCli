#!/usr/bin/env bun
/**
 * scripts/publish.ts — npm 发布辅助脚本
 *
 * 使用方法：
 *   bun run scripts/publish.ts              # 发布所有包（dry-run 预览）
 *   bun run scripts/publish.ts --publish    # 实际发布到 npm
 *
 * 发布顺序（按依赖拓扑序）：
 *   1. @fengagent/shared  （零依赖）
 *   2. @fengagent/core     （依赖 shared）
 *   3. @fengagent/llm      （依赖 core, shared）
 *   4. @fengagent/tools    （依赖 core, shared, context）
 *   5. @fengagent/context  （依赖 core, shared）
 *   6. @fengagent/agent    （依赖 core, shared, llm, tools, context）
 *   7. @fengagent/server   （依赖 agent, core, shared）
 *   8. @fengagent/cli      （依赖 agent, core, shared, server）
 *   9. fengagent           （根包，bin 入口）
 */

import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const PACKAGES = [
  "packages/shared",
  "packages/core",
  "packages/llm",
  "packages/context",
  "packages/tools",
  "packages/agent",
  "packages/server",
  "packages/cli",
];

const doPublish = process.argv.includes("--publish");
const tag = doPublish ? "publish" : "pack --dry-run";

console.log(`\n📦 FengAgentCli npm ${doPublish ? "publish" : "dry-run"}\n`);
console.log(`Mode: ${doPublish ? "🔴 LIVE PUBLISH" : "🟢 DRY RUN"}\n`);

// 1. 前置检查
console.log("Step 1: Pre-publish checks...");

// 类型检查
console.log("  Running typecheck...");
const typecheckProc = Bun.spawn(["bun", "run", "typecheck"], { cwd: root });
const typecheckExit = await typecheckProc.exited;
if (typecheckExit !== 0) {
  console.error("  ✗ Typecheck failed");
  process.exit(1);
}
console.log("  ✓ Typecheck passed");

// 测试
console.log("  Running tests...");
const testProc = Bun.spawn(["bun", "test"], { cwd: root });
const testExit = await testProc.exited;
if (testExit !== 0) {
  console.error("  ✗ Tests failed");
  process.exit(1);
}
console.log("  ✓ Tests passed");

// 构建前端
console.log("  Building web-ui...");
const buildProc = Bun.spawn(["bun", "run", "build:web-ui"], { cwd: root });
const buildExit = await buildProc.exited;
if (buildExit !== 0) {
  console.error("  ✗ web-ui build failed");
  process.exit(1);
}
console.log("  ✓ web-ui built");

// 2. 逐包发布
console.log(`\nStep 2: ${doPublish ? "Publishing" : "Packing (dry-run)"} packages...\n`);

for (const pkg of PACKAGES) {
  const pkgDir = resolve(root, pkg);
  console.log(`  → ${pkg}`);

  const args = doPublish
    ? ["publish", "--access", "public"]
    : ["pack", "--dry-run"];

  const proc = Bun.spawn(["npm", ...args], {
    cwd: pkgDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode] = await Promise.all([proc.exited]);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`  ✗ ${pkg} failed: ${stderr}`);
    process.exit(1);
  }

  console.log(`  ✓ ${pkg}`);
}

// 3. 发布根包
console.log(`\nStep 3: ${doPublish ? "Publishing" : "Packing (dry-run)"} root package (fengagent)...\n`);

const rootArgs = doPublish
  ? ["publish", "--access", "public"]
  : ["pack", "--dry-run"];

const rootProc = Bun.spawn(["npm", ...rootArgs], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});

const [rootExitCode] = await Promise.all([rootProc.exited]);

if (rootExitCode !== 0) {
  const stderr = await new Response(rootProc.stderr).text();
  console.error(`  ✗ root package failed: ${stderr}`);
  process.exit(1);
}

console.log("  ✓ root package (fengagent)");

console.log("\n✅ All packages processed successfully.");
if (!doPublish) {
  console.log("\nTo actually publish, run:");
  console.log("  bun run scripts/publish.ts --publish");
}
