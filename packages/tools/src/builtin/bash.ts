/**
 * @fengagent/tools — bash 内置工具
 *
 * 执行 shell 命令，带超时控制。
 *
 * ## 方言契约（AGENTS 记录，勿再漂移）
 *
 * 工具名 / 描述 / 实际执行引擎**三者必须一致**。历史缺陷：Windows 上描述写
 * 「PowerShell on Windows」，实现却走 `ComSpec`（cmd.exe），模型按描述写
 * `Get-Content` 一类 PowerShell 语法，在 cmd.exe 里报 `not recognized`，
 * 连续失败触发死循环防护——整轮对话白白失败（真机现场：feng小弟 AGE-29）。
 *
 * 现在的执行引擎次序：
 * - win32：`pwsh`（PowerShell 7+）→ `powershell.exe`（Windows PowerShell 5.1）→ `cmd.exe`；
 * - 其它平台：`$SHELL` → `/bin/sh`。
 *
 * 描述由 {@link describeBashTool} 依据**同一份**解析结果生成，因此「描述说的引擎」
 * 就是「真正跑的引擎」；`metadata.shell` 回带实际解释器，可被测试与排查直接核对。
 */
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import type { ToolResult } from "@fengagent/core/tool";
import { ask } from "@fengagent/core/permission";
import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BASH_TIMEOUT } from "@fengagent/shared/constants";

/** Minimal interface for the spawned child process we use. */
interface SpawnedChild {
  stdout: { on: (event: "data", cb: (data: Buffer) => void) => void } | null;
  stderr: { on: (event: "data", cb: (data: Buffer) => void) => void } | null;
  on: (event: "close" | "error", cb: (...args: unknown[]) => void) => void;
  kill: () => void;
}

/** 解析后的 shell 执行方案：描述与执行共用同一份，避免再次漂移。 */
export interface ResolvedShell {
  /** 解释器绝对路径（或 PATH 可解析的命令名）。 */
  command: string;
  /** `command` 后面固定拼接的参数。 */
  args: string[];
  /** 人类可读的解释器名，用于描述与 `metadata.shell`。 */
  label: "pwsh" | "powershell" | "cmd" | "sh";
  /** 方言说明：模型据此写命令，必须与 label 相符。 */
  dialect: string;
}

const inputSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  workdir: z.string().optional().describe("Working directory override (absolute or relative to context workdir)"),
  timeout: z.number().int().positive().optional().describe("Timeout in milliseconds"),
});

type BashInput = z.infer<typeof inputSchema>;

/** Windows 上优先探测的解释器（顺序即优先级）。 */
const WINDOWS_POWERSHELL_CANDIDATES = [
  "pwsh.exe",
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "powershell.exe",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
] as const;

/**
 * 在 PATH / 常见安装位置里找第一个存在的可执行文件。
 *
 * 纯文件系统探测（不 spawn 探针进程）：守护进程子进程环境未必允许起进程，
 * 探测本身不能成为失败源。
 *
 * @param candidate 绝对路径，或 PATH 可解析的命令名
 * @returns 是否存在可用解释器
 */
export function isExecutableAvailable(candidate: string): boolean {
  if (candidate.includes("\\") || candidate.includes("/")) {
    return existsSync(candidate);
  }
  const pathExt = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";");
  const dirs = (process.env.PATH ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    if (existsSync(`${dir}\\${candidate}`)) return true;
    for (const ext of pathExt) {
      if (ext && existsSync(`${dir}\\${candidate}${ext.toLowerCase()}`)) return true;
      if (ext && existsSync(`${dir}\\${candidate}${ext.toUpperCase()}`)) return true;
    }
  }
  return false;
}

/**
 * 解析当前平台实际要用的 shell。
 *
 * Windows 优先 PowerShell：描述一直宣称「PowerShell on Windows」，且 PowerShell
 * 原生提供 `ls`/`cat`/`pwd`/`echo` 等 POSIX 别名，同时又认得 `dir`/`type` 等
 * 传统写法，是覆盖最广的方言。仅当 PowerShell 完全不可用时才退回 cmd.exe。
 *
 * @param platform 目标平台（默认 `process.platform`，测试可注入）
 * @returns 解释器、固定参数、label 与方言说明
 */
export function resolveShell(platform: NodeJS.Platform = process.platform): ResolvedShell {
  if (platform === "win32") {
    for (const candidate of WINDOWS_POWERSHELL_CANDIDATES) {
      if (!isExecutableAvailable(candidate)) continue;
      const label = candidate.toLowerCase().includes("pwsh") ? "pwsh" : "powershell";
      return {
        command: candidate,
        // -NoProfile：不加载用户 profile（daemon 子进程环境里 profile 可能不存在/被策略拦截）
        // -NonInteractive：stdin 已 ignore，避免交互式提示把命令吊死
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
        label,
        dialect: `${label === "pwsh" ? "PowerShell 7" : "Windows PowerShell"} 语法（原生 cmdlet，如 Get-Content / Get-ChildItem；也接受 ls、cat、pwd 等别名）`,
      };
    }
    const cmd = process.env.ComSpec ?? "C:\\Windows\\system32\\cmd.exe";
    return {
      command: cmd,
      args: ["/c"],
      label: "cmd",
      dialect: "cmd.exe 语法（dir /b、type、findstr；不支持 PowerShell cmdlet）",
    };
  }

  return {
    command: process.env.SHELL ?? "/bin/sh",
    args: ["-c"],
    label: "sh",
    dialect: "POSIX shell 语法",
  };
}

/** 模块级缓存：描述与执行共用同一次解析结果，进程内不会漂移。 */
const resolvedShell: ResolvedShell = resolveShell();

/**
 * 生成工具描述——由实际解析出的 shell 反推，保证「名/描述/实现」三方一致。
 *
 * @param shell 已解析的 shell 方案
 * @returns 给模型看的工具描述
 */
export function describeBashTool(shell: ResolvedShell = resolvedShell): string {
  const notes: string[] = [
    "Execute a shell command with timeout control.",
    `Execution engine on this machine: ${shell.label} — ${shell.dialect}.`,
    "The tool is named `bash` for historical reasons; command syntax must match the engine named above, not bash, when they differ.",
  ];
  if (shell.label === "powershell" || shell.label === "pwsh") {
    notes.push(
      "Windows PowerShell 5.1 does not support `&&`; chain with `;` instead.",
      "If PowerShell is missing on a Windows host the engine falls back to cmd.exe, and the command must then be cmd syntax.",
    );
  }
  notes.push(
    "Each call starts a fresh shell (cwd and variables do not persist).",
    "Returns stdout, plus stderr under a `[stderr]` marker when non-empty.",
  );
  return notes.join(" ");
}

/**
 * 构造 bash 工具定义。
 *
 * @param shell 注入的 shell 方案（默认用模块级解析结果，测试可注入）
 * @returns 与 `shell` 严格一致的工具定义
 */
export function createBashTool(shell: ResolvedShell = resolvedShell): ToolDefinition<BashInput> {
  return {
    name: "bash",
    description: describeBashTool(shell),

    inputSchema,

    isReadOnly(): boolean {
      return false;
    },

    isDestructive(): boolean {
      return true;
    },

    isConcurrencySafe(): boolean {
      return false;
    },

    checkPermissions(_input: BashInput) {
      return ask("bash command will execute on the system. Confirm to proceed.");
    },

    async execute(input: BashInput, context: ToolContext): Promise<ToolResult> {
      const shellArgs = [...shell.args, input.command];

      let cwd = context.workdir;
      if (input.workdir) {
        cwd = isAbsolute(input.workdir)
          ? input.workdir
          : `${context.workdir}/${input.workdir}`;
      }

      const timeout = input.timeout ?? BASH_TIMEOUT;

      return new Promise((resolve) => {
        const child = spawn(shell.command, shellArgs, {
          cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        }) as unknown as SpawnedChild;

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        const timer = setTimeout(() => {
          child.kill();
          resolve({
            content: `Command timed out after ${timeout}ms:\n${stdout}${stderr}`,
            isError: true,
            metadata: { exitCode: -1, timedOut: true, shell: shell.label },
          });
        }, timeout);

        child.on("close", (code: unknown) => {
          clearTimeout(timer);
          const exitCode = (code as number | null) ?? 0;
          const output = stderr
            ? `${stdout}\n[stderr]\n${stderr}`
            : stdout;
          const isError = exitCode !== 0;
          resolve({
            content: output || `Command completed with exit code ${exitCode}`,
            isError,
            metadata: { exitCode: exitCode, shell: shell.label },
          });
        });

        child.on("error", (err: unknown) => {
          clearTimeout(timer);
          const error = err as Error;
          resolve({
            content: `Failed to spawn ${shell.label} (${shell.command}): ${error.message}`,
            isError: true,
            metadata: { exitCode: -1, shell: shell.label },
          });
        });
      });
    },

    renderUse(input: BashInput): string {
      const preview = input.command.length > 80
        ? input.command.slice(0, 77) + "..."
        : input.command;
      return `${shell.label}: ${preview}`;
    },
  };
}

/** 默认实例：按本机解析出的 shell 装配。 */
export const bashTool = createBashTool();
