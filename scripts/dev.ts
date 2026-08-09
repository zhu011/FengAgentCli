/**
 * dev.ts — 一键启动开发环境
 *
 * 同时启动后端 server（默认 :3000）和前端 web-ui dev server（:5180）。
 * 任一进程退出时自动终止另一个。
 *
 * 用法：bun run dev
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

type Proc = { name: string; proc: import("node:child_process").ChildProcess };

const procs: Proc[] = [];

function start(name: string, cmd: string, args: string[], cwd: string): Proc {
  const proc = spawn(cmd, args, {
    cwd,
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
  });

  proc.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[${name}] ${data}`);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[${name}] ${data}`);
  });

  proc.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}`);
    cleanup();
    process.exit(code ?? 0);
  });

  return { name, proc };
}

function cleanup() {
  for (const { name, proc } of procs) {
    if (!proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// 启动后端 server
procs.push(
  start("server", "bun", ["run", "packages/server/src/entry.ts"], root),
);

// 启动前端 web-ui dev server
procs.push(
  start("web-ui", "bun", ["run", "dev"], resolve(root, "packages/web-ui")),
);

console.log("\n🚀 FengAgent dev environment started");
console.log("   Server:  http://127.0.0.1:3000");
console.log("   WebUI:   http://localhost:5180");
console.log("   Press Ctrl+C to stop\n");
