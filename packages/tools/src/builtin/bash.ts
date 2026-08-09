/**
 * @fengagent/tools — bash 内置工具
 *
 * 执行 PowerShell/Bash 命令，带超时控制。
 */
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import type { ToolResult } from "@fengagent/core/tool";
import { ask } from "@fengagent/core/permission";
import { z } from "zod";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { BASH_TIMEOUT } from "@fengagent/shared/constants";

/** Minimal interface for the spawned child process we use. */
interface SpawnedChild {
  stdout: { on: (event: "data", cb: (data: Buffer) => void) => void } | null;
  stderr: { on: (event: "data", cb: (data: Buffer) => void) => void } | null;
  on: (event: "close" | "error", cb: (...args: unknown[]) => void) => void;
  kill: () => void;
}

const inputSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  workdir: z.string().optional().describe("Working directory override (absolute or relative to context workdir)"),
  timeout: z.number().int().positive().optional().describe("Timeout in milliseconds"),
});

type BashInput = z.infer<typeof inputSchema>;

export const bashTool: ToolDefinition<BashInput> = {
  name: "bash",
  description: "Execute a shell command (PowerShell on Windows, bash elsewhere) with timeout control.",

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
    const isWin = process.platform === "win32";
    const shell = isWin
      ? process.env.ComSpec ?? "C:\\Windows\\system32\\cmd.exe"
      : process.env.SHELL ?? "/bin/sh";
    const shellArgs = isWin ? ["/c", input.command] : ["-c", input.command];

    let cwd = context.workdir;
    if (input.workdir) {
      cwd = isAbsolute(input.workdir)
        ? input.workdir
        : `${context.workdir}/${input.workdir}`;
    }

    const timeout = input.timeout ?? BASH_TIMEOUT;

    return new Promise((resolve) => {
      const child = spawn(shell, shellArgs, {
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
          metadata: { exitCode: -1, timedOut: true },
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
          metadata: { exitCode: exitCode },
        });
      });

      child.on("error", (err: unknown) => {
        clearTimeout(timer);
        const error = err as Error;
        resolve({
          content: `Failed to spawn process: ${error.message}`,
          isError: true,
          metadata: { exitCode: -1 },
        });
      });
    });
  },

  renderUse(input: BashInput): string {
    const preview = input.command.length > 80
      ? input.command.slice(0, 77) + "..."
      : input.command;
    return `bash: ${preview}`;
  },
};
