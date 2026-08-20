/**
 * @fengagent/cli — Multica 运行时注册（`fengagent runtime install` / `uninstall`）
 *
 * 在 `~/.multica/runtimes/fengagent.json` 写入/删除本地运行时注册文件，
 * 使 Multica 桌面/守护进程在本机发现 FengAgentCli 并作为可用运行时
 * （协议：ACP，launchHeader：`fengagent acp`）。
 *
 * 可移植性：command 优先解析为 PATH 上的全局 `fengagent` 命令；
 * 否则回退到当前可执行文件的绝对路径（编译二进制 / node 启动器 / bun 源码）。
 * 不写死 workdir — 由 Multica 守护进程在任务工作目录中启动。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** 本地运行时注册文件内容 */
export interface RuntimeRegistration {
  provider: string;
  displayName: string;
  launchHeader: string;
  protocol: string;
  command: string;
  args: string[];
  /** 可选：启动工作目录（存在项目配置 .fengagent/config.json 时写入，便于读取 API Key） */
  workdir?: string;
  version: string;
  capabilities: string[];
  description: string;
}

const VERSION = process.env.FENG_VERSION ?? "0.2.0";

/** Multica 本地运行时注册目录（Windows/macOS/Linux 一致） */
export function runtimeRegistrationsDir(): string {
  return join(homedir(), ".multica", "runtimes");
}

/** 注册文件路径 */
export function runtimeRegistrationPath(): string {
  return join(runtimeRegistrationsDir(), "fengagent.json");
}

/** 判断命令是否在 PATH 上 */
function isOnPath(cmd: string): boolean {
  const probe = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [cmd],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

/**
 * 探测可用的配置根目录：若当前工作目录（或仓库根）存在
 * `.fengagent/config.json`，则注册时带上该 workdir，保证 Multica
 * 启动运行时时能读到项目配置文件中的 API Key；否则省略 workdir（可移植，
 * 由守护进程在任务工作目录中启动，API Key 走环境变量或 ~/.fengagent/config.json）。
 */
export function resolveWorkdir(): string | undefined {
  const candidates = [process.cwd()];
  // 从仓库内运行（bin/ 或 scripts/ 下）时，仓库根更可能是配置根
  const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
  const dirs = [process.cwd(), dirname(dirname(argv1))];
  for (const dir of dirs) {
    if (dir && dir !== process.cwd()) candidates.push(dir);
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, ".fengagent", "config.json"))) {
      return dir;
    }
  }
  return undefined;
}

/**
 * 解析当前运行方式，得到可被 Multica 守护进程直接启动的 command/args。
 *
 * 优先级：
 * 1. PATH 上的全局 `fengagent` 命令（最可移植，其他电脑安装后自动命中）
 * 2. 当前可执行文件本身（已编译二进制：fengagent-win-x64.exe 等）
 * 3. node 启动器（bin/fengagent.js）
 * 4. bun 源码直跑（bun run packages/cli/src/entry.ts）
 */
export function resolveLaunchCommand(): {
  command: string;
  args: string[];
} {
  // 1. 优先使用 PATH 上的全局 fengagent 命令
  if (isOnPath("fengagent")) {
    return { command: "fengagent", args: ["acp"] };
  }

  const execPath = process.execPath;
  const execName = basename(execPath).toLowerCase();

  // 2. 已编译二进制（dist/fengagent-*）
  if (execName.includes("fengagent")) {
    return { command: execPath, args: ["acp"] };
  }

  const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";

  // 3. node 启动器（bin/fengagent.js）
  if (execName.includes("node")) {
    return { command: execPath, args: [argv1, "acp"] };
  }

  // 4. bun 源码直跑（bun run .../entry.ts）
  return { command: execPath, args: ["run", argv1, "acp"] };
}

/** 构建注册内容 */
export function buildRegistration(): RuntimeRegistration {
  const { command, args } = resolveLaunchCommand();
  const workdir = resolveWorkdir();
  const reg: RuntimeRegistration = {
    provider: "fengagent",
    displayName: "FengAgentCli",
    launchHeader: "fengagent acp",
    protocol: "acp",
    command,
    args,
    version: VERSION,
    capabilities: ["text", "tools", "streaming", "multi-agent", "mcp"],
    description: "开源本地 AI Agent CLI 工具 — 对话、工具调用、多Agent、WebUI",
  };
  if (workdir) {
    reg.workdir = workdir;
  }
  return reg;
}

/**
 * 写入本地运行时注册文件。
 *
 * @returns 实际写入的文件路径
 */
export function installRuntimeRegistration(): string {
  const dir = runtimeRegistrationsDir();
  mkdirSync(dir, { recursive: true });
  const file = runtimeRegistrationPath();
  const reg = buildRegistration();
  writeFileSync(file, JSON.stringify(reg, null, 2) + "\n", "utf-8");
  return file;
}

/**
 * 删除本地运行时注册文件。
 *
 * @returns 被删除的文件路径；文件不存在时返回 null
 */
export function uninstallRuntimeRegistration(): string | null {
  const file = runtimeRegistrationPath();
  if (existsSync(file)) {
    rmSync(file, { force: true });
    return file;
  }
  return null;
}
