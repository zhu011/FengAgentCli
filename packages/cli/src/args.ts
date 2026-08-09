/**
 * @fengagent/cli — 命令行参数解析
 *
 * 解析 --model、--port、--session、--serve 等参数。
 * 支持 `feng serve` 子命令模式。
 */

/** 解析后的命令行参数 */
export interface ParsedArgs {
  /** 模型 ID 覆盖 */
  model?: string;
  /** 服务端口 */
  port?: number;
  /** 恢复已有会话 ID */
  session?: string;
  /** 是否启动 WebUI 服务模式 */
  serve: boolean;
  /** 是否强制非交互模式（--print） */
  print: boolean;
  /** 额外的位置参数（非选项参数） */
  positional: string[];
  /** 是否显示帮助 */
  help: boolean;
  /** 是否显示版本 */
  version: boolean;
}

/** 参数解析错误 */
export interface ArgParseError {
  message: string;
  arg?: string;
}

/**
 * 解析命令行参数。
 *
 * 支持的参数：
 * - `--model <id>` / `-m <id>` — 指定模型
 * - `--port <n>` / `-p <n>` — 指定服务端口
 * - `--session <id>` / `-s <id>` — 恢复已有会话
 * - `serve` — 启动 WebUI 服务模式
 * - `--help` / `-h` — 显示帮助
 * - `--version` / `-v` — 显示版本
 * - `--` — 后续参数均为位置参数
 *
 * @param argv - 命令行参数数组（不含 node/bun 路径）
 * @returns 解析结果
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    serve: false,
    print: false,
    positional: [],
    help: false,
    version: false,
  };

  let i = 0;
  let positionalOnly = false;

  while (i < argv.length) {
    const arg = argv[i]!;

    if (positionalOnly) {
      result.positional.push(arg);
      i++;
      continue;
    }

    switch (arg) {
      case "--":
        positionalOnly = true;
        break;
      case "serve":
        result.serve = true;
        break;
      case "--print":
        result.print = true;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--version":
      case "-v":
        result.version = true;
        break;
      case "--model":
      case "-m":
        i++;
        if (i < argv.length) {
          result.model = argv[i];
        } else {
          throw { message: `--model requires a value`, arg } satisfies ArgParseError;
        }
        break;
      case "--port":
      case "-p":
        i++;
        if (i < argv.length) {
          const port = Number(argv[i]);
          if (Number.isNaN(port) || port < 1 || port > 65535) {
            throw {
              message: `Invalid port: ${argv[i]}`,
              arg,
            } satisfies ArgParseError;
          }
          result.port = port;
        } else {
          throw { message: `--port requires a value`, arg } satisfies ArgParseError;
        }
        break;
      case "--session":
      case "-s":
        i++;
        if (i < argv.length) {
          result.session = argv[i];
        } else {
          throw {
            message: `--session requires a value`,
            arg,
          } satisfies ArgParseError;
        }
        break;
      default:
        // 支持 --key=value 语法
        if (arg.startsWith("--model=")) {
          result.model = arg.slice("--model=".length);
        } else if (arg.startsWith("--port=")) {
          const port = Number(arg.slice("--port=".length));
          if (Number.isNaN(port) || port < 1 || port > 65535) {
            throw {
              message: `Invalid port in ${arg}`,
              arg,
            } satisfies ArgParseError;
          }
          result.port = port;
        } else if (arg.startsWith("--session=")) {
          result.session = arg.slice("--session=".length);
        } else if (arg.startsWith("-")) {
          throw {
            message: `Unknown option: ${arg}`,
            arg,
          } satisfies ArgParseError;
        } else {
          result.positional.push(arg);
        }
        break;
    }
    i++;
  }

  return result;
}

/** 生成帮助文本 */
export function getHelpText(): string {
  return `FengAgentCli — 本地 AI Agent CLI 工具

用法: feng [选项] [提示文本]
      feng serve [选项]

选项:
  -m, --model <id>       指定模型 ID
  -p, --port <n>         服务端口 (默认: 3000)
  -s, --session <id>     恢复已有会话
  --print                强制非交互模式（输出到 stdout）
  -h, --help             显示帮助
  -v, --version          显示版本

子命令:
  serve                  启动 WebUI 服务模式

示例:
  feng "帮我读取 package.json"
  feng --model claude-sonnet-4-20250514 "解释这段代码"
  feng --session abc-123 "继续上次对话"
  echo "修复这个 bug" | feng
  feng serve --port 8080

交互命令 (TUI 模式):
  /help                  显示帮助
  /session new           新建会话
  /session list          列出会话
  /session switch <id>   切换会话
  /model <id>            切换模型
  /export [file]         导出当前会话
  /clear                 清屏
  /exit                  退出`;
}

/** 版本号（编译时可通过 --define process.env.FENG_VERSION 注入） */
export const VERSION = process.env.FENG_VERSION ?? "0.1.0";
