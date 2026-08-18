/**
 * @fengagent/tools — sandbox 内置工具
 *
 * 把「实验性操作」放进隔离沙箱执行，保护本地文件与环境：
 * - run：在沙箱内执行临时代码/命令（cwd=沙箱根、环境脱敏、超时强杀）；
 * - write / read / delete / list：沙箱内的文件操作（路径围栏，杜绝 `..` 逃逸）；
 * - copy-in：把宿主文件（只读）导入沙箱供实验；
 * - copy-out：把沙箱产物导出到宿主 —— 唯一出口，需权限审批；
 * - status：查看当前会话沙箱根路径。
 *
 * 沙箱按会话（sessionId）隔离复用；会话结束或进程退出后由 dispose 清理。
 * 除 copy-out（写宿主）外，沙箱内操作视为安全、自动放行，不影响原有工具行为。
 */

import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import type { ToolResult } from "@fengagent/core/tool";
import { ask } from "@fengagent/core/permission";
import { z } from "zod";
import { Sandbox } from "../sandbox.ts";

const inputSchema = z.object({
  action: z.enum([
    "run",
    "write",
    "read",
    "delete",
    "list",
    "copy-in",
    "copy-out",
    "status",
  ]).describe("Sandbox action"),
  path: z.string().optional().describe("Path inside the sandbox (relative to sandbox root)"),
  content: z.string().optional().describe("File content (for write)"),
  command: z.string().optional().describe("Shell command to run inside the sandbox (for run)"),
  timeout: z.number().int().positive().optional().describe("Command timeout in ms (for run, default 120000)"),
  source: z.string().optional().describe("Host path to import into the sandbox (for copy-in)"),
  dest: z.string().optional().describe("Host destination path (for copy-out) or sandbox destination (for copy-in)"),
});

type SandboxInput = z.infer<typeof inputSchema>;

/* ─────────────────────────── 会话级沙箱注册表 ─────────────────────────── */

const sandboxes = new Map<string, Sandbox>();

/** 获取（或惰性创建）当前会话的沙箱 */
function sandboxFor(context: ToolContext): Sandbox {
  const key = context.sessionId || "default";
  const existing = sandboxes.get(key);
  if (existing && !existing.disposed) {
    return existing;
  }
  const sandbox = new Sandbox();
  sandboxes.set(key, sandbox);
  return sandbox;
}

/** 释放指定会话的沙箱（幂等） */
export function disposeSandbox(sessionId: string): void {
  const sb = sandboxes.get(sessionId);
  if (sb) {
    sb.dispose();
    sandboxes.delete(sessionId);
  }
}

/** 释放全部沙箱（测试/进程退出清理用，幂等） */
export function disposeAllSandboxes(): void {
  for (const [key, sb] of sandboxes) {
    sb.dispose();
    sandboxes.delete(key);
  }
}

/* ─────────────────────────── 工具定义 ─────────────────────────── */

export const sandboxTool: ToolDefinition<SandboxInput> = {
  name: "sandbox",
  description:
    "Run experimental operations (temp file create/delete, temp code execution) inside an isolated sandbox. " +
    "Files and environment of the host are never touched: paths are confined to the sandbox root, " +
    "child-process env is scrubbed of API keys/tokens, and commands are killed on timeout. " +
    "Use copy-in to import host files for experiments and copy-out (requires approval) to export results.",

  inputSchema,

  // 读类动作（read/list/status）只读
  isReadOnly(input: SandboxInput): boolean {
    return (
      input.action === "read" ||
      input.action === "list" ||
      input.action === "status"
    );
  },

  // 只有 copy-out 会写宿主文件系统，其余动作都封闭在沙箱内
  isDestructive(input: SandboxInput): boolean {
    return input.action === "copy-out";
  },

  isConcurrencySafe(): boolean {
    return false;
  },

  // 沙箱内操作自动放行；copy-out（写宿主）必须审批
  checkPermissions(input: SandboxInput) {
    if (input.action === "copy-out") {
      return ask(
        "sandbox copy-out will write to the host filesystem outside the sandbox. Confirm to proceed.",
      );
    }
    return { decision: "allow" as const };
  },

  async execute(input: SandboxInput, context: ToolContext): Promise<ToolResult> {
    const sandbox = sandboxFor(context);
    try {
      switch (input.action) {
        case "run": {
          if (!input.command) {
            return { content: "action 'run' requires 'command'", isError: true };
          }
          const result = await sandbox.runCommand(input.command, {
            timeout: input.timeout,
          });
          const lines: string[] = [];
          if (result.stdout) lines.push(result.stdout);
          if (result.stderr) lines.push(`[stderr]\n${result.stderr}`);
          if (result.timedOut) lines.push("[timed out]");
          if (lines.length === 0) {
            lines.push(`Command completed with exit code ${result.exitCode}`);
          }
          return {
            content: lines.join("\n"),
            metadata: {
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              sandboxRoot: sandbox.root,
            },
          };
        }

        case "write": {
          if (!input.path || input.content === undefined) {
            return {
              content: "action 'write' requires 'path' and 'content'",
              isError: true,
            };
          }
          const abs = sandbox.writeFile(input.path, input.content);
          return {
            content: `Wrote ${input.content.length} chars to sandbox file ${input.path}`,
            metadata: { path: abs, size: input.content.length },
          };
        }

        case "read": {
          if (!input.path) {
            return { content: "action 'read' requires 'path'", isError: true };
          }
          return { content: sandbox.readFile(input.path) };
        }

        case "delete": {
          if (!input.path) {
            return { content: "action 'delete' requires 'path'", isError: true };
          }
          const removed = sandbox.remove(input.path);
          return {
            content: removed
              ? `Removed sandbox path ${input.path}`
              : `Sandbox path not found: ${input.path}`,
          };
        }

        case "list": {
          const entries = sandbox.list(input.path ?? ".");
          return {
            content:
              entries.length > 0
                ? entries.join("\n")
                : "(sandbox is empty)",
            metadata: { count: entries.length },
          };
        }

        case "copy-in": {
          if (!input.source) {
            return { content: "action 'copy-in' requires 'source'", isError: true };
          }
          const abs = sandbox.copyIn(input.source, input.dest);
          return {
            content: `Imported ${input.source} into sandbox (${abs})`,
            metadata: { sandboxPath: abs },
          };
        }

        case "copy-out": {
          if (!input.path || !input.dest) {
            return {
              content: "action 'copy-out' requires 'path' and 'dest'",
              isError: true,
            };
          }
          const abs = sandbox.copyOut(input.path, input.dest);
          return {
            content: `Exported sandbox file ${input.path} to ${abs}`,
            metadata: { hostPath: abs },
          };
        }

        case "status": {
          return {
            content: `Sandbox root: ${sandbox.root}\nEnvironment: scrubbed (API keys/tokens removed), HOME/TEMP inside sandbox\nSession: ${context.sessionId || "default"}`,
            metadata: { sandboxRoot: sandbox.root },
          };
        }

        default: {
          return {
            content: `Unknown sandbox action: ${String((input as { action?: unknown }).action)}`,
            isError: true,
          };
        }
      }
    } catch (err) {
      return {
        content: `sandbox ${input.action} failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },

  renderUse(input: SandboxInput): string {
    switch (input.action) {
      case "run":
        return `sandbox run: ${(input.command ?? "").slice(0, 60)}`;
      case "write":
        return `sandbox write ${input.path ?? ""} (${(input.content ?? "").length} chars)`;
      case "read":
        return `sandbox read ${input.path ?? ""}`;
      case "delete":
        return `sandbox delete ${input.path ?? ""}`;
      case "list":
        return `sandbox list ${input.path ?? ""}`;
      case "copy-in":
        return `sandbox copy-in ${input.source ?? ""} → ${input.dest ?? ""}`;
      case "copy-out":
        return `sandbox copy-out ${input.path ?? ""} → ${input.dest ?? ""}`;
      default:
        return "sandbox status";
    }
  },
};
