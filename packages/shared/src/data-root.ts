/**
 * @fengagent/shared — 数据根目录解析（main 分支）
 *
 * 优先级：`FENG_DATA_DIR` 环境变量 > 工作目录 `.fengagent/`。
 *
 * main **只认自己的数据根**，不探测 `.fengagent-cordis/`（AGE-29 第 9 条 B 方案）：
 * 那是 refactor/cordis 分支的数据根，main 碰它会让两分支在两分支同目录并存的开发机上
 * 互相读写对方的数据（会话历史「消失」、分支数据互相污染）。
 */

import { join } from "node:path";
import { expandTilde } from "./utils.ts";

export interface DataRootOptions {
  /** 工作目录（默认 process.cwd()） */
  workdir?: string;
  /** 环境变量（默认 process.env；测试可注入） */
  env?: Record<string, string | undefined>;
}

/**
 * 解析数据根目录（main 分支）。
 *
 * 优先级：`FENG_DATA_DIR` > `<workdir>/.fengagent`。
 *
 * 不探测 `<workdir>/.fengagent-cordis`（refactor 分支的数据根）——
 * 详见文件头说明。
 */
export function resolveDataRoot(opts: DataRootOptions = {}): string {
  const env = opts.env ?? process.env;
  if (env.FENG_DATA_DIR && env.FENG_DATA_DIR !== "") {
    return env.FENG_DATA_DIR;
  }
  const cwd = opts.workdir ?? process.cwd();
  return join(cwd, ".fengagent");
}

/** 日志目录 = 数据根/logs */
export function getLogDir(): string {
  return join(resolveDataRoot(), "logs");
}

/**
 * 解析日志目录（绝对路径）= `<数据根>/logs`。
 *
 * 与 `getLogDir()` 的区别在于可传 `workdir`，因此写入方（llm/trace、logger、
 * session-log）与读取方（server 的 observability 路由）走同一套优先级：
 * `FENG_DATA_DIR` > `<workdir>/.fengagent`。设置 `FENG_DATA_DIR` 时不再出现
 * 「写一处、读另一处」。
 *
 * @param opts - 与 `resolveDataRoot` 相同的选项
 * @returns 日志目录绝对路径
 */
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
