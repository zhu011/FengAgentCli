/**
 * @fengagent/shared — 数据根目录解析
 *
 * 优先级：`FENG_DATA_DIR` 环境变量 > 工作目录 `.fengagent-cordis/`（refactor 分支）> `.fengagent/`（main 分支）
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DataRootOptions {
  /** 工作目录（默认 process.cwd()） */
  workdir?: string;
}

/**
 * 解析当前分支数据根目录。
 *
 * 优先级：`FENG_DATA_DIR` > `.fengagent-cordis/`（refactor 分支）> `.fengagent/`（main 分支）
 */
export function resolveDataRoot(opts: DataRootOptions = {}): string {
  if (process.env.FENG_DATA_DIR && process.env.FENG_DATA_DIR !== "") {
    return process.env.FENG_DATA_DIR;
  }
  const cwd = opts.workdir ?? process.cwd();
  const cordis = join(cwd, ".fengagent-cordis");
  if (existsSync(cordis)) return cordis;
  return join(cwd, ".fengagent");
}

/** 日志目录 = 数据根/logs */
export function getLogDir(): string {
  return join(resolveDataRoot(), "logs");
}
