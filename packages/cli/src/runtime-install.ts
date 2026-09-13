/**
 * @fengagent/cli — Multica 运行时注册（`fengagent runtime install` / `uninstall`）
 *
 * 在 `~/.multica/runtimes/fengagent.json` 写入/删除本地运行时注册文件，
 * 使 Multica 桌面/守护进程在本机发现 FengAgentCli 并作为可用运行时
 * （协议：ACP，launchHeader：`fengagent acp`）。
 *
 * 可移植性：command 优先解析为 PATH 上的全局 `fengagent` 命令；
 * 否则回退到当前可执行文件的绝对路径（编译二进制 / node 启动器 / bun 源码）。
 *
 * 凭据可见性：Multica 每次对话都会在**全新的空工作目录**里拉起运行时
 * （`task-<id>/workdir`），cwd 下没有 `.fengagent/config.json`，因此注册时
 * 会顺带把项目级凭据「补齐」到全局配置 `~/.fengagent/config.json`，
 * 让运行时在任意工作目录都能解析到 Provider 凭据。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  promoteCredentialsToGlobal,
  readConfigFileSync,
  type PartialConfig,
  type PortableCredentialKey,
} from "@fengagent/core";
import { CORDIS_CONFIG_PATH, PROJECT_CONFIG_PATH } from "@fengagent/shared";

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

/** 可能的项目配置根目录（cwd 优先，其次仓库根） */
function configRootCandidates(): string[] {
  const candidates = [process.cwd()];
  const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
  const repoRoot = argv1 ? dirname(dirname(argv1)) : "";
  if (repoRoot && repoRoot !== process.cwd()) {
    candidates.push(repoRoot);
  }
  return candidates;
}

/**
 * 探测可用的配置根目录：若当前工作目录（或仓库根）存在
 * `.fengagent/config.json`，则返回该目录 — 注册时会带上该 workdir，
 * 并从这里读取项目级凭据补齐全局配置。
 *
 * @returns 含项目配置的目录；未找到时 undefined
 */
export function resolveWorkdir(): string | undefined {
  for (const dir of configRootCandidates()) {
    if (existsSync(join(dir, ".fengagent", "config.json"))) {
      return dir;
    }
  }
  return undefined;
}

/**
 * 读取项目配置根目录下的凭据来源（项目级 + 分支级，分支级优先）。
 *
 * @param dir - 项目配置根目录
 * @returns 合并后的凭据补丁（分支级覆盖项目级）
 */
export function readProjectCredentials(dir: string): PartialConfig {
  const project = readConfigFileSync(join(dir, PROJECT_CONFIG_PATH));
  const cordis = readConfigFileSync(join(dir, CORDIS_CONFIG_PATH));
  return { ...project, ...cordis } as PartialConfig;
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

/** installRuntimeRegistration 的选项 */
export interface InstallRuntimeOptions {
  /** 是否把项目级凭据补齐到全局配置（默认 true） */
  seedGlobalConfig?: boolean;
  /** 全局配置文件路径覆盖（测试用，默认 ~/.fengagent/config.json） */
  globalConfigPath?: string;
  /** 项目配置根目录覆盖（测试用，默认自动探测） */
  projectDir?: string;
}

/** 凭据补齐结果 */
export interface CredentialSeedResult {
  /** 全局配置文件路径 */
  path: string;
  /** 本次写入的键 */
  keys: PortableCredentialKey[];
}

/** installRuntimeRegistration 的返回值 */
export interface InstallRuntimeResult {
  /** 运行时注册文件路径 */
  file: string;
  /** 写入的注册内容 */
  registration: RuntimeRegistration;
  /** 凭据补齐结果（未补齐时为 null） */
  credentials: CredentialSeedResult | null;
}

/**
 * 写入本地运行时注册文件，并把项目级凭据补齐到全局配置。
 *
 * 为什么需要补齐：Multica 每次对话都在全新的空工作目录
 * （`task-<id>/workdir`）里拉起运行时，cwd 下没有 `.fengagent/config.json`，
 * 注册文件里的 workdir 对「自定义运行时 profile」并不生效；只有全局配置
 * `~/.fengagent/config.json` 能让凭据在任何工作目录可见。
 *
 * @param options - 可选：跳过凭据补齐 / 覆盖路径（测试）
 * @returns 注册文件路径 + 写入内容 + 凭据补齐结果
 */
export function installRuntimeRegistration(
  options: InstallRuntimeOptions = {},
): InstallRuntimeResult {
  const dir = runtimeRegistrationsDir();
  mkdirSync(dir, { recursive: true });
  const file = runtimeRegistrationPath();
  const reg = buildRegistration();
  writeFileSync(file, JSON.stringify(reg, null, 2) + "\n", "utf-8");

  let credentials: CredentialSeedResult | null = null;
  if (options.seedGlobalConfig !== false) {
    const projectDir = options.projectDir ?? resolveWorkdir();
    if (projectDir) {
      const promoted = promoteCredentialsToGlobal(readProjectCredentials(projectDir), {
        globalPath: options.globalConfigPath,
      });
      if (promoted) {
        credentials = { path: promoted.path, keys: promoted.keys };
      }
    }
  }

  return { file, registration: reg, credentials };
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
