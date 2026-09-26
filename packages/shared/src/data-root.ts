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
 * 解析「会话仓」根目录 —— 守护进程指定时以它为准。
 *
 * Multica 守护进程为每个 (runtime, agent, thread) 建一个会话仓
 * （`~/.multica/profiles/<profile>/hermes-sessions/<agent_id>/default/<thread_id>/`），
 * 并在下一轮任务开始时据此判定 `session_home_reachable`。判定为 false 时守护进程
 * 直接丢掉前一个会话（`dropping prior session: session store not reachable from this
 * run`），于是 `session/resume` 永远走不到 —— 即使桥已经实现了 resume 并声明了
 * `agentCapabilities.loadSession`。
 *
 * 守护进程把仓的位置通过 `MULTICA_DSH_SESSION_ROOT` 交给运行时；运行时的会话库必须
 * 落在那里，否则守护进程看不到、续聊可达性恒为 false。变量缺失时退回 `resolveDataRoot()`，
 * 行为与之前完全一致（当前生产路径就是这种情形，见 `docs/verify/AGE-29-session-resume-probe.md`）。
 *
 * @param opts - 与 `resolveDataRoot` 相同的选项
 * @returns 会话仓绝对路径
 */
export function resolveSessionStoreRoot(opts: DataRootOptions = {}): string {
  const env = opts.env ?? process.env;
  const designated = env.MULTICA_DSH_SESSION_ROOT;
  if (designated && designated !== "") {
    return expandTilde(designated);
  }
  return resolveDataRoot(opts);
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
