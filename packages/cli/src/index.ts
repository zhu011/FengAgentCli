/**
 * @fengagent/cli — CLI 终端交互
 *
 * Ink TUI 交互界面、命令行参数解析、非交互模式。
 * 参考 PRD 第 4.2.6 节。
 */

export { runPrintMode } from "./print-mode.ts";
export type { PrintModeOptions } from "./print-mode.ts";

export { parseArgs, type ParsedArgs, type ArgParseError } from "./args.ts";

export { createAgent } from "./create-agent.ts";
export type { CreateAgentOptions } from "./create-agent.ts";
