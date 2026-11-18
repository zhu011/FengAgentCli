/**
 * @fengagent/server — 智能体 → 运行时绑定解析（P0）
 *
 * 一个智能体绑定 **0 或 1 个** runtime（1:1，owner 已拍板），`runtime_fallbacks`
 * 只作为「主 runtime 不可用时按序降级」的候选，不是「同时绑多个」。
 *
 * 解析顺序（spec §5.1.2）：
 * 1. `agent.runtime` 存在、已注册、enabled、最近探测 `probeStatus === "ok"` → 用它；
 * 2. 否则按 `runtime_fallbacks` 顺序找第一个可用；
 * 3. 都没有 → 返回带原因码的失败（派单侧把它变成 409/400 + 明确提示，不静默失败）。
 *
 * 为什么不在这里真探测：dsh 冷启实测 ~13s，派单前再探一次会让请求翻倍。
 * 探测是用户显式动作（`POST /api/runtimes/:name/probe`）或启动后台探测，
 * 这里只消费最近一次结果；unprobed 的运行时给出可操作提示。
 */

import type { AgentRecord } from "@fengagent/agent";
import type { RuntimeInfo } from "./agent-runtimes.ts";

/** 绑定解析失败原因码 */
export type AgentRuntimeResolveCode =
  | "agent_archived"
  | "agent_runtime_required"
  | "runtime_not_found"
  | "runtime_disabled"
  | "runtime_unavailable"
  | "runtime_unprobed";

/** 解析成功 */
export interface AgentRuntimeResolveOk {
  ok: true;
  runtime: RuntimeInfo;
  /** 是否走了降级候选 */
  viaFallback: boolean;
  /** 尝试过的候选顺序（诊断用） */
  candidates: string[];
}

/** 解析失败 */
export interface AgentRuntimeResolveFail {
  ok: false;
  code: AgentRuntimeResolveCode;
  message: string;
  candidates: string[];
}

/** 解析结果 */
export type AgentRuntimeResolution = AgentRuntimeResolveOk | AgentRuntimeResolveFail;

/**
 * 解析智能体应使用的运行时。
 *
 * @param agent - 智能体记录
 * @param runtimes - 当前注册表卡片（含 probeStatus / enabled）
 */
export function resolveRuntimeForAgent(
  agent: AgentRecord,
  runtimes: readonly RuntimeInfo[],
): AgentRuntimeResolution {
  if (agent.archivedAt !== undefined) {
    return {
      ok: false,
      code: "agent_archived",
      message: `智能体已归档，不能再派单: ${agent.id}`,
      candidates: [],
    };
  }
  const candidates = [agent.runtime, ...agent.runtimeFallbacks].filter(
    (name): name is string => typeof name === "string" && name !== "",
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "agent_runtime_required",
      message: `智能体 ${agent.id} 尚未绑定运行时：请先在详情页绑定一个 runtime 再派单`,
      candidates: [],
    };
  }
  const unique = [...new Set(candidates)];
  const byName = new Map(runtimes.map((info) => [info.name, info]));
  const failures: Array<{ name: string; code: AgentRuntimeResolveCode; reason: string }> = [];

  for (const name of unique) {
    const info = byName.get(name);
    if (!info) {
      failures.push({ name, code: "runtime_not_found", reason: "未注册" });
      continue;
    }
    if (!info.enabled) {
      failures.push({ name, code: "runtime_disabled", reason: "已停用" });
      continue;
    }
    if (info.probeStatus === "unreachable") {
      failures.push({
        name,
        code: "runtime_unavailable",
        reason: info.probeError ?? "探测不可达",
      });
      continue;
    }
    if (info.probeStatus !== "ok") {
      failures.push({ name, code: "runtime_unprobed", reason: "尚未探测（探针未通过）" });
      continue;
    }
    return {
      ok: true,
      runtime: info,
      viaFallback: name !== unique[0],
      candidates: unique,
    };
  }

  const primary = failures[0];
  const code = primary?.code ?? "runtime_unavailable";
  const detail = failures
    .map((failure) => `${failure.name}（${failure.reason}）`)
    .join("、");
  return {
    ok: false,
    code,
    message: `智能体 ${agent.id} 没有可用的运行时：${detail || unique.join("、")}。请先探测/启用运行时，或改绑其它 runtime`,
    candidates: unique,
  };
}

/**
 * 校验「绑定」值本身是否合法（创建/改绑时用，不要求探测通过 —— 允许先绑后探）。
 *
 * @param runtime - 目标注册名；null = 解绑
 * @param runtimes - 当前注册表
 * @returns 错误消息；合法返回 null
 */
export function validateRuntimeBinding(
  runtime: string | null,
  runtimes: readonly RuntimeInfo[],
): string | null {
  if (runtime === null) return null;
  const info = runtimes.find((item) => item.name === runtime);
  if (!info) {
    const names = runtimes.map((item) => item.name).join(" / ") || "（无）";
    return `运行时未注册: ${runtime}。可用运行时：${names}`;
  }
  return null;
}

/** 绑定/解析失败（路由映射 HTTP 契约 `{error:{message,code}}`） */
export class AgentRuntimeBindingError extends Error {
  readonly code: AgentRuntimeResolveCode | "agent_not_found" | "invocation_not_allowed";
  readonly status: 400 | 403 | 404 | 409;

  constructor(
    code: AgentRuntimeBindingError["code"],
    message: string,
    status?: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "AgentRuntimeBindingError";
    this.code = code;
    this.status =
      status ??
      (code === "agent_not_found"
        ? 404
        : code === "invocation_not_allowed"
          ? 403
          : code === "agent_runtime_required" || code === "runtime_not_found"
            ? 400
            : 409);
  }

  toPayload(): { error: { message: string; code: string } } {
    return { error: { message: this.message, code: this.code } };
  }
}
