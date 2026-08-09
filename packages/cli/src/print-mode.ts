/**
 * @fengagent/cli — 非交互模式
 *
 * 从 stdin 读取输入，发送给 Agent，将响应输出到 stdout。
 * 支持管道用法：`echo "修复 bug" | feng`
 *
 * 流式文本输出到 stdout，工具调用和错误输出到 stderr。
 */

import type { Agent } from "@fengagent/agent";
import type { Session } from "@fengagent/core";
import chalk from "chalk";

/** Print 模式选项 */
export interface PrintModeOptions {
  /** Agent 实例 */
  agent: Agent;
  /** 输入文本（如未提供则从 stdin 读取） */
  input?: string;
  /** 恢复已有会话（可选） */
  session?: Session;
  /** 是否输出颜色（默认自动检测 TTY） */
  color?: boolean;
}

/**
 * 从 stdin 读取全部输入。
 * 支持 `echo "text" | feng` 和 `cat file | feng` 等管道用法。
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data.trim());
    });
    process.stdin.on("error", reject);
  });
}

/**
 * 运行非交互模式。
 *
 * 行为：
 * - 文本流式输出到 stdout（不添加额外格式）
 * - 工具调用信息输出到 stderr（带颜色）
 * - Token 用量输出到 stderr
 * - 错误输出到 stderr
 * - 结束后输出换行
 */
export async function runPrintMode(
  options: PrintModeOptions,
): Promise<void> {
  const { agent } = options;

  // 获取输入
  const input = options.input ?? (await readStdin());
  if (!input) {
    process.stderr.write(chalk.red("Error: No input provided\n"));
    process.exit(1);
  }

  const c = chalk;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let hasError = false;

  try {
    for await (const event of agent.prompt(input, options.session)) {
      switch (event.type) {
        case "text-delta":
          process.stdout.write(event.text);
          break;

        case "tool-call-start":
          process.stderr.write(
            c.cyan(`\n⚡ ${event.name}(${formatInput(event.input)})\n`),
          );
          break;

        case "tool-call-result": {
          const result = event.result;
          const status = result.isError ? c.red("✗") : c.green("✓");
          const preview = truncateForStderr(result.content, 200);
          process.stderr.write(`${status} ${preview}\n`);
          break;
        }

        case "usage":
          totalInputTokens += event.inputTokens;
          totalOutputTokens += event.outputTokens;
          break;

        case "error":
          hasError = true;
          process.stderr.write(
            c.red(`\nError: ${event.error.message}\n`),
          );
          if (event.error.code) {
            process.stderr.write(c.gray(`Code: ${event.error.code}\n`));
          }
          break;

        case "compaction-start":
          process.stderr.write(c.gray("… 压缩上下文中…\n"));
          break;

        case "compaction-end":
          process.stderr.write(c.gray("✓ 上下文压缩完成\n"));
          break;

        // 忽略的事件
        case "session-start":
        case "message-start":
        case "message-end":
        case "turn-end":
        case "session-end":
          break;
      }
    }

    // 输出换行
    process.stdout.write("\n");

    // Token 用量（仅在有消耗时输出）
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      process.stderr.write(
        c.gray(
          `\nTokens: ${totalInputTokens} in / ${totalOutputTokens} out\n`,
        ),
      );
    }

    if (hasError) {
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(c.red(`\nFatal: ${message}\n`));
    process.exit(1);
  }
}

/** 格式化工具输入参数（截断长内容） */
function formatInput(input: unknown): string {
  if (input === null || input === undefined) {
    return "";
  }
  const str = typeof input === "string" ? input : JSON.stringify(input);
  return truncateForStderr(str, 100);
}

/** 截断字符串用于 stderr 输出 */
function truncateForStderr(text: string, maxLen: number): string {
  const singleLine = text.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return singleLine.slice(0, maxLen - 3) + "...";
}
