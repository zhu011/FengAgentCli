/**
 * @fengagent/tools — 实验沙箱（Sandbox）
 *
 * 为「实验性操作」提供隔离执行环境：
 * - 删除/新建临时文件 → 全部重定向到沙箱根目录内的独立目录，绝不触碰宿主文件；
 * - 执行临时代码/命令 → 子进程 cwd 固定在沙箱根内，环境变量脱敏（剥离 API Key /
 *   Token / Secret 及 FENG_*、MULTICA_* 配置），HOME / TEMP / TMP 指向沙箱内目录；
 * - 沙箱与宿主之间的数据流通全部显式：copy-in（宿主 → 沙箱，只读源）、
 *   copy-out（沙箱 → 宿主，唯一出口，需工具层权限审批）。
 *
 * 安全模型：
 * 1. 路径围栏（path confinement）— resolvePath 归一化后必须落在沙箱根内，
 *    任何 `..` 逃逸或沙箱外的绝对路径都会抛 SandboxEscapeError；
 * 2. 环境脱敏（env scrubbing）— 子进程环境剔除敏感变量，避免临时代码窃取凭据；
 * 3. 超时控制 — 命令默认 BASH_TIMEOUT，超时强杀，防止失控进程；
 * 4. 自动清理 — dispose() 递归删除沙箱根（幂等）。
 *
 * 说明：runCommand 通过文件重定向捕获输出（stdio: ignore），而非管道 —
 * 既避免大输出时管道缓冲区死锁，也兼容受限环境（禁止管道捕获子进程输出的场景）。
 */

import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { BASH_TIMEOUT } from "@fengagent/shared/constants";

/** 沙箱子进程环境标记（临时代码可据此识别自己运行在沙箱内） */
export const SANDBOX_ENV_MARKER = "FENG_SANDBOX";

/**
 * 沙箱内隐藏的输出日志文件名（runCommand 用）。
 *
 * 使用相对文件名（cwd 固定在沙箱根）而非绝对路径：Windows cmd 在受限环境下
 * 对「带引号的绝对路径重定向」解析不稳定，相对名规避该问题（见 sandbox.test.ts 说明）。
 */
const OUT_LOG = ".feng-sandbox-out.log";
const ERR_LOG = ".feng-sandbox-err.log";

/** 敏感变量名匹配（命中即从子进程环境中剥离） */
const SECRET_PATTERN =
  /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH|SIGNING|SESSION[_-]?KEY)/i;

/**
 * 路径逃逸错误 — 尝试访问沙箱根之外的路径时抛出。
 */
export class SandboxEscapeError extends Error {
  /** 尝试访问的（原始）路径 */
  readonly attemptedPath: string;
  /** 沙箱根目录 */
  readonly sandboxRoot: string;

  constructor(attemptedPath: string, sandboxRoot: string) {
    super(
      `Sandbox escape denied: "${attemptedPath}" is outside sandbox root "${sandboxRoot}"`,
    );
    this.name = "SandboxEscapeError";
    this.attemptedPath = attemptedPath;
    this.sandboxRoot = sandboxRoot;
  }
}

export interface SandboxOptions {
  /** 沙箱根目录的父目录（默认 os.tmpdir()） */
  baseDir?: string;
  /** 沙箱目录名前缀（默认 "fengagent-sandbox-"） */
  prefix?: string;
  /** dispose() 时是否删除沙箱根（默认 true） */
  cleanupOnDispose?: boolean;
  /** 额外的敏感变量名匹配（追加到默认脱敏规则） */
  extraScrubPatterns?: RegExp[];
}

export interface SandboxCommandOptions {
  /** 超时毫秒（默认 BASH_TIMEOUT） */
  timeout?: number;
  /** 追加/覆盖子进程环境变量（在脱敏之后应用） */
  env?: Record<string, string | undefined>;
}

/** Minimal interface for the spawned child process we use (与 builtin/bash.ts 同款模式). */
interface SpawnedChild {
  pid?: number;
  on: (event: "error" | "close", cb: (...args: unknown[]) => void) => void;
  kill: () => void;
}

export interface SandboxCommandResult {
  /** 进程退出码；-1 = 未能启动 */
  exitCode: number;
  /** stdout 内容 */
  stdout: string;
  /** stderr 内容 */
  stderr: string;
  /** 是否超时被杀 */
  timedOut: boolean;
  /** 原始命令 */
  command: string;
}

/**
 * 实验沙箱 — 所有文件操作与命令执行都被限制在独立根目录内。
 */
export class Sandbox {
  /** 沙箱根目录（绝对路径） */
  readonly root: string;

  private readonly homeDir: string;
  private readonly tmpDir: string;
  private readonly cleanupOnDispose: boolean;
  private readonly extraScrubPatterns: RegExp[];
  private disposedFlag = false;

  constructor(options: SandboxOptions = {}) {
    const base = options.baseDir ?? tmpdir();
    mkdirSync(base, { recursive: true });
    this.root = mkdtempSync(join(base, options.prefix ?? "fengagent-sandbox-"));
    this.homeDir = join(this.root, ".home");
    this.tmpDir = join(this.root, ".tmp");
    mkdirSync(this.homeDir, { recursive: true });
    mkdirSync(this.tmpDir, { recursive: true });
    this.cleanupOnDispose = options.cleanupOnDispose ?? true;
    this.extraScrubPatterns = options.extraScrubPatterns ?? [];
  }

  /** 沙箱是否已销毁 */
  get disposed(): boolean {
    return this.disposedFlag;
  }

  /* ─────────────────────────── 路径围栏 ─────────────────────────── */

  /**
   * 将（相对/绝对）路径解析为沙箱根内的绝对路径。
   *
   * 任何逃出沙箱根的路径都会抛 SandboxEscapeError：
   * - `..` 穿越（如 `../x`、`a/../../x`）；
   * - 指向沙箱根之外的绝对路径；
   * - 路径归一化后的符号链接目标（不做 follow，仅字符串级围栏 —
   *   沙箱内文件均为自建，不引入外部链接）。
   */
  resolvePath(relPath: string): string {
    if (typeof relPath !== "string" || relPath.length === 0) {
      throw new Error("sandbox path is required");
    }
    const abs = isAbsolute(relPath)
      ? normalize(relPath)
      : resolve(this.root, relPath);
    const rootWithSep = this.root.endsWith(sep)
      ? this.root
      : `${this.root}${sep}`;
    if (abs !== this.root && !abs.startsWith(rootWithSep)) {
      throw new SandboxEscapeError(relPath, this.root);
    }
    return abs;
  }

  /* ─────────────────────────── 文件操作（围栏内） ─────────────────────────── */

  /** 在沙箱内写文件（自动创建父目录），返回绝对路径 */
  writeFile(relPath: string, content: string): string {
    const abs = this.resolvePath(relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
    return abs;
  }

  /** 读取沙箱内文件 */
  readFile(relPath: string): string {
    return readFileSync(this.resolvePath(relPath), "utf-8");
  }

  /** 删除沙箱内文件或目录（递归）；返回是否曾存在 */
  remove(relPath: string): boolean {
    const abs = this.resolvePath(relPath);
    if (!existsSync(abs)) return false;
    rmSync(abs, { recursive: true, force: true });
    return true;
  }

  /** 列出沙箱内内容（递归），目录以 "/" 结尾；路径不存在时返回空数组 */
  list(relPath = "."): string[] {
    const abs = this.resolvePath(relPath);
    if (!existsSync(abs)) return [];
    const basePrefix =
      relPath === "." ? "" : normalize(relPath).replace(/\\/g, "/");
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          out.push(`${rel}/`);
          walk(join(dir, entry.name), rel);
        } else {
          out.push(rel);
        }
      }
    };
    walk(abs, basePrefix);
    return out.sort();
  }

  /* ─────────────────────────── 宿主 ↔ 沙箱 数据流通（显式） ─────────────────────────── */

  /** 复制宿主文件/目录进入沙箱（源只读），返回沙箱内绝对路径 */
  copyIn(hostPath: string, destRel?: string): string {
    const src = resolve(hostPath);
    if (!existsSync(src)) {
      throw new Error(`copy-in source not found: ${hostPath}`);
    }
    const dest = destRel
      ? this.resolvePath(destRel)
      : join(this.root, basename(src));
    mkdirSync(dirname(dest), { recursive: true });
    const st = statSync(src);
    if (st.isDirectory()) {
      cpSync(src, dest, { recursive: true });
    } else {
      copyFileSync(src, dest);
    }
    return dest;
  }

  /** 导出沙箱内文件/目录到宿主（唯一出口，调用方须自行做权限把关） */
  copyOut(relPath: string, hostDest: string): string {
    const src = this.resolvePath(relPath);
    if (!existsSync(src)) {
      throw new Error(`sandbox file not found: ${relPath}`);
    }
    const dest = resolve(hostDest);
    mkdirSync(dirname(dest), { recursive: true });
    const st = statSync(src);
    if (st.isDirectory()) {
      cpSync(src, dest, { recursive: true });
    } else {
      copyFileSync(src, dest);
    }
    return dest;
  }

  /* ─────────────────────────── 环境脱敏 ─────────────────────────── */

  /**
   * 环境变量脱敏（纯函数）。
   *
   * 剔除：
   * - 名称命中 SECRET_PATTERN（API Key / Token / Secret / Password / 凭据…）；
   * - `FENG_*`（agent 自身配置，不应暴露给临时代码）；
   * - `MULTICA_*`（运行时凭据/工作区信息）；
   * - 调用方 extraScrubPatterns 追加的规则。
   *
   * 保留 PATH 等基础变量，保证命令可执行。
   */
  static scrubEnv(
    env: NodeJS.ProcessEnv,
    options: { extraPatterns?: RegExp[] } = {},
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      if (key.startsWith("FENG_") || key.startsWith("MULTICA_")) continue;
      if (SECRET_PATTERN.test(key)) continue;
      if (options.extraPatterns?.some((p) => p.test(key))) continue;
      out[key] = value;
    }
    return out;
  }

  /** 构建子进程环境：脱敏 + HOME/TEMP/TMP 指向沙箱内 + 沙箱标记 */
  private buildChildEnv(
    extra?: Record<string, string | undefined>,
  ): Record<string, string> {
    const env = Sandbox.scrubEnv(process.env, {
      extraPatterns: this.extraScrubPatterns,
    });
    env.HOME = this.homeDir;
    env.USERPROFILE = this.homeDir;
    env.TEMP = this.tmpDir;
    env.TMP = this.tmpDir;
    env[SANDBOX_ENV_MARKER] = "1";
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) {
          delete env[key];
        } else {
          env[key] = value;
        }
      }
    }
    return env;
  }

  /* ─────────────────────────── 命令执行（沙箱内） ─────────────────────────── */

  /**
   * 在沙箱内执行 shell 命令（cmd on Windows，sh/bash 其它平台）。
   *
   * - cwd 固定在沙箱根；
   * - 环境脱敏（见 buildChildEnv）；
   * - 输出经文件重定向捕获（避免管道缓冲区死锁 / 兼容受限环境）；
   * - 命令以 `( ... )` 子组包裹：`&`/`&&` 链的完整输出、退出码、stderr 都能正确捕获，
   *   且组内双引号命令（如 `node -e "..."`）不受影响（Windows 上配合
   *   windowsVerbatimArguments 直传命令行，规避 cmd /c 的引号剥离问题）；
   * - 默认超时 BASH_TIMEOUT，超时强杀（Windows 用 taskkill /T 杀进程树，
   *   POSIX 用进程组 SIGKILL）。
   */
  async runCommand(
    command: string,
    options: SandboxCommandOptions = {},
  ): Promise<SandboxCommandResult> {
    if (typeof command !== "string" || command.trim().length === 0) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: "empty command",
        timedOut: false,
        command,
      };
    }
    const isWin = process.platform === "win32";
    const shell = isWin
      ? process.env.ComSpec ?? "C:\\Windows\\system32\\cmd.exe"
      : process.env.SHELL ?? "/bin/sh";

    // 相对输出名 — cwd 已固定在沙箱根；避免把绝对路径（可能含空格）嵌入命令行
    const fullCommand = `(${command}) > ${OUT_LOG} 2> ${ERR_LOG}`;

    const timeout = options.timeout ?? BASH_TIMEOUT;
    const env = this.buildChildEnv(options.env);

    return new Promise<SandboxCommandResult>((resolvePromise) => {
      let killedByTimeout = false;
      let child: SpawnedChild;
      try {
        child = spawn(
          shell,
          isWin
            ? ["/d", "/s", "/c", fullCommand]
            : ["-c", fullCommand],
          {
            cwd: this.root,
            env,
            stdio: ["ignore", "ignore", "ignore"],
            // Windows：直传命令行，避免 Node 自动加引号破坏 cmd /c 的引号语义
            ...(isWin ? { windowsVerbatimArguments: true } : {}),
            // POSIX：独立进程组，便于超时整组强杀
            ...(isWin ? {} : { detached: true }),
          },
        ) as unknown as SpawnedChild;
      } catch (err) {
        resolvePromise({
          exitCode: -1,
          stdout: "",
          stderr: `failed to spawn: ${(err as Error).message}`,
          timedOut: false,
          command,
        });
        return;
      }

      const timer = setTimeout(() => {
        killedByTimeout = true;
        try {
          if (isWin && child.pid) {
            // 杀进程树（/T），避免 cmd 被杀后子进程继续运行
            spawn(
              "taskkill",
              ["/pid", String(child.pid), "/T", "/F"],
              { stdio: "ignore" },
            );
          } else if (child.pid) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          // 进程可能已退出 — 忽略
        }
        try {
          child.kill();
        } catch {
          // 同上
        }
      }, timeout);

      child.on("error", (err: unknown) => {
        clearTimeout(timer);
        resolvePromise({
          exitCode: -1,
          stdout: "",
          stderr: `failed to spawn: ${(err as Error).message}`,
          timedOut: false,
          command,
        });
      });

      child.on("close", (code: unknown) => {
        clearTimeout(timer);
        let stdout = "";
        let stderr = "";
        try {
          stdout = readFileSync(join(this.root, OUT_LOG), "utf-8");
        } catch {
          // 命令未产生输出 — 保持空串
        }
        try {
          stderr = readFileSync(join(this.root, ERR_LOG), "utf-8");
        } catch {
          // 无 stderr — 保持空串
        }
        resolvePromise({
          exitCode: killedByTimeout ? -1 : ((code as number | null) ?? 0),
          stdout,
          stderr,
          timedOut: killedByTimeout,
          command,
        });
      });
    });
  }

  /* ─────────────────────────── 清理 ─────────────────────────── */

  /** 删除沙箱根目录（幂等）。超时被杀的子进程可能短暂持有文件句柄，做有限重试。 */
  dispose(): void {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    if (!this.cleanupOnDispose) return;

    const sleep = (ms: number) => {
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      } catch {
        // 极老环境无 Atomics.wait — 直接放弃等待
      }
    };

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(this.root, { recursive: true, force: true });
        return;
      } catch {
        // EBUSY 等瞬时锁定 — 稍后重试
        sleep(30);
      }
    }
    // 最终仍失败则静默放弃（临时目录残留可接受，OS 会最终释放）
  }
}
