/**
 * @fengagent/shared — 数据根解析（Phase 0：两分支同机运行数据隔离）
 *
 * resolveDataRoot(workdir) 决定新分支所有运行时数据的落盘根目录：
 *   FENG_DATA_DIR（若设置）            # 显式覆盖，优先级最高
 *   else 配置文件 dataDir（若自定义）    # .fengagent-cordis/config.json 中的 dataDir
 *   else <workdir>/.fengagent-cordis/  # 新分支默认
 *
 * 对 main 的 `.fengagent/` 与 `~/.fengagent/` 一律只读（仅作导入源 / 配置回退）。
 */

import { join, resolve } from "node:path";
import {
  CORDIS_DATA_DIR,
  DEFAULT_DATA_DIR,
  MAIN_DATA_DIR,
  MAIN_GLOBAL_DATA_DIR,
} from "./constants.ts";
import { expandTilde } from "./utils.ts";

/** 数据根解析选项 */
export interface DataRootOptions {
  /** 工作目录（默认 process.cwd()） */
  workdir?: string;
  /** 环境变量（默认 process.env；测试可注入） */
  env?: Record<string, string | undefined>;
  /** 配置文件中的 dataDir（未设置/默认值时忽略） */
  configDataDir?: string;
}

/**
 * 解析新分支运行时数据根（绝对路径）。
 *
 * 优先级：`FENG_DATA_DIR` > 配置文件自定义 `dataDir` > `<workdir>/.fengagent-cordis`。
 */
export function resolveDataRoot(opts: DataRootOptions = {}): string {
  const env = opts.env ?? process.env;
  const workdir = opts.workdir ?? process.cwd();

  const explicit = env.FENG_DATA_DIR;
  if (explicit && explicit !== "") {
    return expandTilde(explicit);
  }
  if (opts.configDataDir && opts.configDataDir !== DEFAULT_DATA_DIR) {
    return expandTilde(opts.configDataDir);
  }
  return join(resolve(workdir), CORDIS_DATA_DIR);
}

/** 日志目录 = <数据根>/logs */
export function resolveLogsDir(opts: DataRootOptions = {}): string {
  return join(resolveDataRoot(opts), "logs");
}

/**
 * main 遗留数据根探测顺序（导入源）：
 * `FENG_MAIN_DATA_DIR` → `<workdir>/.fengagent` → `~/.fengagent` → `<workdir>/data`（旧 cordis 遗留）。
 */
export function resolveMainDataRoots(opts: DataRootOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const workdir = opts.workdir ?? process.cwd();
  const roots: string[] = [];
  if (env.FENG_MAIN_DATA_DIR && env.FENG_MAIN_DATA_DIR !== "") {
    roots.push(expandTilde(env.FENG_MAIN_DATA_DIR));
  }
  roots.push(join(resolve(workdir), MAIN_DATA_DIR));
  roots.push(expandTilde(MAIN_GLOBAL_DATA_DIR));
  roots.push(join(resolve(workdir), "data"));
  return roots;
}
