/**
 * dev.ts — 一键启动开发环境
 *
 * 同时启动后端 server（默认 :3000）和前端 web-ui dev server（:5180）。
 * 任一进程退出时自动终止另一个。
 *
 * 用法：bun run dev
 */

import { spawn, execSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";

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
    if (code !== 0) {
      console.error(`[${name}] 进程异常退出（code=${code}），终止所有进程`);
    }
    cleanup();
    process.exit(code ?? 0);
  });

  return { name, proc };
}

function cleanup() {
  for (const { proc } of procs) {
    if (proc.exitCode !== null) continue;
    try {
      if (isWindows && proc.pid) {
        // Windows 上 SIGTERM 不会真正终止 bun 子进程，需用 taskkill /F /T 杀整棵进程树。
        // 用 execSync 同步执行，确保在 process.exit 之前真正完成清理（否则残留进程占用端口）。
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
      } else {
        proc.kill("SIGTERM");
      }
    } catch {
      // 进程可能已退出，忽略 taskkill 报错
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

// 等待后端 server 启动后再启动前端（避免 Vite 代理到不存在的后端）
setTimeout(() => {
  procs.push(
    start("web-ui", "bun", ["run", "dev"], resolve(root, "packages/web-ui")),
  );
}, 2000);

console.log("\n🚀 FengAgent dev environment starting...");
console.log("   Server:  http://127.0.0.1:3000 (starting...)");
console.log("   WebUI:   http://localhost:5180 (starting in 2s...)");
console.log("   Press Ctrl+C to stop\n");
