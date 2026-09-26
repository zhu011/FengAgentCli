/**
 * @fengagent/shared — 数据根目录解析
 *
 * 优先级：`FENG_DATA_DIR` 环境变量 > 工作目录 `.fengagent-cordis/`（refactor 分支）> `.fengagent/`（main 分支）
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandTilde } from "./utils.ts";

export interface DataRootOptions {
  /** 工作目录（默认 process.cwd()） */
  workdir?: string;
  /** 环境变量（默认 process.env；测试可注入） */
  env?: Record<string, string | undefined>;
}

/**
 * 解析当前分支数据根目录。
 *
 * 优先级：`FENG_DATA_DIR` > `.fengagent-cordis/`（refactor 分支）> `.fengagent/`（main 分支）
 */
export function resolveDataRoot(opts: DataRootOptions = {}): string {
  const env = opts.env ?? process.env;
  if (env.FENG_DATA_DIR && env.FENG_DATA_DIR !== "") {
    return env.FENG_DATA_DIR;
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
