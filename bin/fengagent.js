#!/usr/bin/env node
/**
 * FengAgentCli 全局启动入口（npm bin / 直接安装后 `fengagent` 命令）
 *
 * 启动策略（按优先级）：
 * 1. 平台对应的预编译二进制（dist/fengagent-<platform>）— 无需任何运行时
 * 2. `bun run packages/cli/src/entry.ts` — 源码直跑（开发 / 未编译二进制时）
 *
 * 该文件由 npm 全局安装后生成 `fengagent` 命令（Windows 下为 fengagent.cmd），
 * 任何电脑上安装后即可直接 `fengagent` 启动 TUI，`fengagent acp` 启动 ACP 服务。
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 平台 → dist 二进制文件名映射 */
const BINARY_MAP = [
  { platform: "win32", arch: "x64", file: "fengagent-win-x64.exe" },
  { platform: "linux", arch: "x64", file: "fengagent-linux-x64" },
  { platform: "darwin", arch: "arm64", file: "fengagent-darwin-arm64" },
];

function resolveBinary() {
  for (const candidate of BINARY_MAP) {
    if (
      candidate.platform === process.platform &&
      candidate.arch === process.arch
    ) {
      const bin = join(ROOT, "dist", candidate.file);
      return existsSync(bin) ? bin : null;
    }
  }
  return null;
}

function resolveBun() {
  // Windows: bun.exe；unix: bun
  const cmd = process.platform === "win32" ? "bun.exe" : "bun";
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return probe.status === 0 ? cmd : null;
}

const binary = resolveBinary();
const args = process.argv.slice(2);

if (binary) {
  const child = spawn(binary, args, { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
} else {
  const bun = resolveBun();
  if (!bun) {
    process.stderr.write(
      "错误：未找到预编译二进制，且未安装 Bun 运行时。\n" +
        "请先安装 Bun（https://bun.sh/），或使用包含 dist/ 二进制的安装包。\n",
    );
    process.exit(1);
  }
  const entry = join(ROOT, "packages", "cli", "src", "entry.ts");
  const child = spawn(bun, ["run", entry, ...args], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}
