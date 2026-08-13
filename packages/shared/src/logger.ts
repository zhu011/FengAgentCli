/**
 * @fengagent/shared — 分级日志器
 *
 * 支持分级日志（debug/info/warn/error），落盘到本地文件 + 控制台输出。
 * 每条日志包含时间戳、模块名、函数名，便于快速定位问题。
 *
 * 日志级别通过环境变量 FENG_LOG_LEVEL 控制（默认 info）。
 * 日志文件路径：{workdir}/.fengagent/logs/fengagent-{date}.log
 *
 * 用法：
 * ```ts
 * import { createLogger } from "@fengagent/shared";
 * const log = createLogger("server");
 * log.info("sendMessage", `sessionId=${sessionId}, text=${text.slice(0, 50)}`);
 * log.error("streamSSE", `Failed: ${err.message}`);
 * ```
 */

import { resolve, join } from "node:path";
import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { getEnv } from "./utils.ts";

/** 日志级别 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 级别优先级（数字越大优先级越高） */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 从环境变量读取日志级别 */
function getLogLevel(): LogLevel {
  const level = getEnv("FENG_LOG_LEVEL", "info").toLowerCase();
  if (level in LEVEL_PRIORITY) return level as LogLevel;
  return "info";
}

/** 格式化时间戳 */
function timestamp(): string {
  return new Date().toISOString();
}

/** 日志目录路径 */
function getLogDir(): string {
  const workdir = process.cwd();
  const logDir = resolve(workdir, ".fengagent/logs");
  if (!existsSync(logDir)) {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      // 目录创建失败 — 仅控制台输出
    }
  }
  return logDir;
}

/** 当天日志文件路径 */
function getLogFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(getLogDir(), `fengagent-${date}.log`);
}

/** 写入日志文件（追加模式） */
function writeToFile(message: string): void {
  try {
    appendFileSync(getLogFile(), message + "\n", "utf-8");
  } catch {
    // 文件写入失败 — 忽略，仅控制台输出
  }
}

/**
 * 创建模块级日志器。
 *
 * @param moduleName - 模块名（如 "server"、"agent"、"cli"）
 * @returns Logger 对象，包含 debug/info/warn/error 方法
 *
 * 每条日志格式：
 * `[2026-08-13T14:30:00.000Z] [INFO] [server] [sendMessage] sessionId=xxx, text=你好...`
 */
export function createLogger(moduleName: string) {
  const minLevel = getLogLevel();

  function log(level: LogLevel, funcName: string, message: string): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

    const line = `[${timestamp()}] [${level.toUpperCase()}] [${moduleName}] [${funcName}] ${message}`;

    // 控制台输出
    switch (level) {
      case "debug":
        // debug 仅在 FENG_LOG_LEVEL=debug 时输出
        if (minLevel === "debug") console.debug(line);
        break;
      case "info":
        console.log(line);
        break;
      case "warn":
        console.warn(line);
        break;
      case "error":
        console.error(line);
        break;
    }

    // 落盘
    writeToFile(line);
  }

  return {
    debug(funcName: string, message: string): void {
      log("debug", funcName, message);
    },
    info(funcName: string, message: string): void {
      log("info", funcName, message);
    },
    warn(funcName: string, message: string): void {
      log("warn", funcName, message);
    },
    error(funcName: string, message: string): void {
      log("error", funcName, message);
    },
  };
}

/** Logger 类型 */
export type Logger = ReturnType<typeof createLogger>;
