/**
 * @fengagent/web-ui — Agents 外派能力的 mock 后端
 *
 * P2 后端（acp-client + /api/agent-tasks）落地前的演示/联调数据源：
 * 页面探测到真实 API 不可用时自动回退到这里。契约与 client.ts 的
 * Agents 方法一一对齐（listRuntimes / listAgentTasks / getAgentTask /
 * createAgentTask / cancelAgentTask / retryAgentTask / streamAgentTask）。
 *
 * 演示语义：create 后任务走 created → dispatched → running（流式输出若干块）
 * → replied 的完整 7 态生命周期；cancel 在非终态生效；retry 对终态失败任务
 * 重新走一遍。事件日志与 anet 任务详情的时间线同构。
 */

import type {
  AgentTask,
  AgentTaskCreateRequest,
  AgentTaskDetailResponse,
  AgentTaskEvent,
  AgentTaskListResponse,
  AgentTaskStreamEvent,
  RuntimeInfo,
} from "./types.ts";

/** 演示 runtime（数据来自 2026-10 本机真实探测结果） */
const MOCK_RUNTIMES: RuntimeInfo[] = [
  {
    name: "dsh",
    command: "dsh-acp-r.exe acp",
    agentName: "deepseek-harness-acp",
    agentVersion: "0.2.1-rc.2",
    capabilities: { resume: true, loadSession: false, image: false },
    probeStatus: "ok",
    probedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    enabled: true,
    recentTaskCount: 3,
  },
  {
    name: "kimi",
    command: "kimi acp",
    agentName: "Kimi Code CLI",
    agentVersion: "0.34.0",
    capabilities: { resume: true, loadSession: true, image: true },
    probeStatus: "ok",
    probedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    enabled: true,
    recentTaskCount: 1,
  },
  {
    name: "fengagent",
    command: "fengagent acp",
    agentName: "fengagent-acp",
    agentVersion: "0.2.0",
    capabilities: { resume: true, loadSession: true, image: false },
    probeStatus: "ok",
    probedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    enabled: true,
    recentTaskCount: 0,
  },
];

interface MockTaskState {
  task: AgentTask;
  events: AgentTaskEvent[];
  /** 流式输出缓冲（running 期间追加，replied 时并入 result） */
  streamText: string;
  /** 活跃定时器（cancel/终态时清理） */
  timers: ReturnType<typeof setTimeout>[];
  /** 订阅者（详情页 SSE 透传） */
  listeners: Set<(ev: AgentTaskStreamEvent) => void>;
}

let nextSeq = 1;
let nextId = 1;

function emit(state: MockTaskState, ev: AgentTaskStreamEvent) {
  for (const listener of state.listeners) {
    try {
      listener(ev);
    } catch {
      // 单个订阅者异常不影响其他订阅者
    }
  }
}

function appendEvent(state: MockTaskState, type: AgentTaskEvent["type"], detail?: string): AgentTaskEvent {
  const event: AgentTaskEvent = { seq: nextSeq++, at: new Date().toISOString(), type, detail };
  state.events.push(event);
  emit(state, { type: "event", event });
  return event;
}

function setStatus(state: MockTaskState, status: AgentTask["status"]) {
  state.task.status = status;
  emit(state, { type: "status", task: { ...state.task } });
}

function finish(state: MockTaskState, status: "replied" | "failed", text: string) {
  for (const t of state.timers) clearTimeout(t);
  state.timers = [];
  state.task.finishedAt = new Date().toISOString();
  state.task.durationMs =
    new Date(state.task.finishedAt).getTime() - new Date(state.task.createdAt).getTime();
  if (status === "replied") {
    state.task.result = text;
    appendEvent(state, "task/replied", `${text.length} 字符`);
  } else {
    state.task.error = text;
    appendEvent(state, "task/failed", text);
  }
  setStatus(state, status);
}

/** 把一个任务从当前态推进到终态（模拟 acp-client 驱动子 agent） */
function drive(state: MockTaskState, replyText: string) {
  const chunkDelay = 350;
  const chunkCount = 8;

  // created → dispatched → running
  const t1 = setTimeout(() => {
    state.task.dispatchedAt = new Date().toISOString();
    appendEvent(state, "task/dispatched", `spawn: ${state.task.runtime}`);
    setStatus(state, "dispatched");
    const t2 = setTimeout(() => {
      state.task.acpSessionId = `acp-${Math.random().toString(36).slice(2, 10)}`;
      state.task.startedAt = new Date().toISOString();
      appendEvent(state, "task/accepted");
      appendEvent(state, "task/running", `session: ${state.task.acpSessionId}`);
      setStatus(state, "running");

      // running：流式输出块
      const words = replyText.split(/(?<=。|\n)/);
      let emitted = 0;
      const emitChunk = () => {
        if (state.task.status !== "running") return;
        if (emitted >= chunkCount || emitted >= words.length) {
          finish(state, "replied", state.streamText || replyText);
          return;
        }
        const text = words[emitted] ?? "";
        emitted += 1;
        state.streamText += text;
        appendEvent(state, "task/stream-chunk");
        emit(state, { type: "chunk", text });
        state.timers.push(setTimeout(emitChunk, chunkDelay));
      };
      state.timers.push(setTimeout(emitChunk, chunkDelay));
    }, 600);
    state.timers.push(t2);
  }, 400);
  state.timers.push(t1);
}

const REPLY_TEMPLATES = [
  "收到任务。分析如下：这是一个演示回复，用于展示外派任务的流式输出与终态回填。完成后状态机会落到 replied，事件日志保留全时间线。",
  "已完成排查：mock 后端按 7 态状态机推进（created → dispatched → running → replied），流式块模拟 session/update 的 agent_message_chunk 语义。",
  "结论：目标 runtime 已按 ACP 协议执行一轮并返回结果。真实后端落地后本页无需改动，API 契约一致。",
];

/** mock 任务仓（页面实例持有，刷新即重置——仅演示用） */
export class AgentTasksMock {
  private states = new Map<string, MockTaskState>();
  private runtimes: RuntimeInfo[] = MOCK_RUNTIMES.map((r) => ({ ...r }));

  constructor() {
    // 预置几条历史任务覆盖各终态
    this.seed(
      "dsh",
      "检查 .fengagent-cordis 数据根的会话存储结构",
      "replied",
      "会话以 SQLite 存储，task_states/task_events 两表承担状态机与事件流。",
    );
    this.seed("kimi", "总结今天的日报", "replied", "日报已生成，共 5 项要点。");
    this.seed(
      "dsh",
      "跑一个不存在的脚本 ./missing.sh",
      "failed",
      "spawn 失败：Command failed: dsh-acp-r.exe acp (exit 1)",
    );
    this.seed("kimi", "翻译这段文档（已过期）", "expired", undefined);
    this.seed("fengagent", "用户手动取消的示例任务", "cancelled", undefined);
  }

  private seed(runtime: string, content: string, status: AgentTask["status"], result?: string) {
    const id = `t_mock_${String(nextId++).padStart(3, "0")}`;
    const createdAt = new Date(Date.now() - Math.floor(Math.random() * 3600_000));
    const state: MockTaskState = {
      task: {
        id,
        fromSession: "dashboard",
        runtime,
        status,
        content,
        result: status === "replied" ? result : undefined,
        error: status === "failed" ? result : undefined,
        createdAt: createdAt.toISOString(),
        durationMs: status === "replied" || status === "failed" ? 12_000 + Math.floor(Math.random() * 30_000) : undefined,
        acpSessionId: status === "created" ? undefined : `acp-${Math.random().toString(36).slice(2, 10)}`,
      },
      events: [],
      streamText: "",
      timers: [],
      listeners: new Set(),
    };
    appendEvent(state, "task/created", `runtime: ${runtime}`);
    if (status !== "created") appendEvent(state, "task/dispatched", `spawn: ${runtime}`);
    if (status === "replied" || status === "failed" || status === "running") {
      appendEvent(state, "task/running");
    }
    if (status === "replied") appendEvent(state, "task/replied");
    if (status === "failed") appendEvent(state, "task/failed", result);
    if (status === "expired") appendEvent(state, "task/expired");
    if (status === "cancelled") appendEvent(state, "task/cancelled");
    this.states.set(id, state);
  }

  listRuntimes(): Promise<RuntimeInfo[]> {
    return Promise.resolve(this.runtimes.map((r) => ({ ...r })));
  }

  listAgentTasks(): Promise<AgentTaskListResponse> {
    const tasks = [...this.states.values()].map((s) => ({ ...s.task })).reverse();
    return Promise.resolve({
      tasks,
      runtimes: this.runtimes.map((r) => ({ ...r })),
    });
  }

  getAgentTask(taskId: string): Promise<AgentTaskDetailResponse> {
    const state = this.states.get(taskId);
    if (!state) return Promise.reject(new Error(`task not found: ${taskId}`));
    return Promise.resolve({
      task: { ...state.task },
      events: state.events.map((e) => ({ ...e })),
    });
  }

  createAgentTask(req: AgentTaskCreateRequest): Promise<AgentTask> {
    const runtime = this.runtimes.find((r) => r.name === req.runtime && r.enabled);
    if (!runtime) {
      return Promise.reject(new Error(`unknown or disabled runtime: ${req.runtime}`));
    }
    const id = `t_mock_${String(nextId++).padStart(3, "0")}`;
    const state: MockTaskState = {
      task: {
        id,
        fromSession: req.fromSession ?? "dashboard",
        runtime: req.runtime,
        status: "created",
        content: req.content,
        createdAt: new Date().toISOString(),
      },
      events: [],
      streamText: "",
      timers: [],
      listeners: new Set(),
    };
    appendEvent(state, "task/created", `runtime: ${req.runtime}`);
    this.states.set(id, state);
    const reply = REPLY_TEMPLATES[Math.floor(Math.random() * REPLY_TEMPLATES.length)] ?? "";
    drive(state, reply);
    runtime.recentTaskCount += 1;
    return Promise.resolve({ ...state.task });
  }

  cancelAgentTask(taskId: string): Promise<AgentTask> {
    const state = this.states.get(taskId);
    if (!state) return Promise.reject(new Error(`task not found: ${taskId}`));
    if (["replied", "failed", "cancelled", "expired"].includes(state.task.status)) {
      return Promise.reject(new Error(`task already terminal: ${state.task.status}`));
    }
    for (const t of state.timers) clearTimeout(t);
    state.timers = [];
    appendEvent(state, "task/cancelled");
    state.task.finishedAt = new Date().toISOString();
    setStatus(state, "cancelled");
    return Promise.resolve({ ...state.task });
  }

  retryAgentTask(taskId: string): Promise<AgentTask> {
    const state = this.states.get(taskId);
    if (!state) return Promise.reject(new Error(`task not found: ${taskId}`));
    if (!["failed", "cancelled", "expired"].includes(state.task.status)) {
      return Promise.reject(new Error(`task not retryable: ${state.task.status}`));
    }
    // 幂等台账语义：retry 生成新执行轮次，事件流续写
    appendEvent(state, "task/retried");
    state.task.status = "created";
    state.task.error = undefined;
    state.task.result = undefined;
    state.task.createdAt = new Date().toISOString();
    state.task.dispatchedAt = undefined;
    state.task.startedAt = undefined;
    state.task.finishedAt = undefined;
    state.task.durationMs = undefined;
    state.streamText = "";
    setStatus(state, "created");
    drive(state, REPLY_TEMPLATES[Math.floor(Math.random() * REPLY_TEMPLATES.length)] ?? "");
    return Promise.resolve({ ...state.task });
  }

  /** 订阅任务流（与 client.streamAgentTask 同构；当前快照 + 后续增量） */
  async *streamAgentTask(req: {
    taskId: string;
    signal?: AbortSignal;
  }): AsyncGenerator<AgentTaskStreamEvent> {
    const { taskId } = req;
    const state = this.states.get(taskId);
    if (!state) throw new Error(`task not found: ${taskId}`);
    // 先回放当前快照（事件 + 状态 + 已积累的流式文本）
    for (const event of state.events) {
      yield { type: "event", event };
    }
    yield { type: "chunk", text: state.streamText };
    yield { type: "status", task: { ...state.task } };
    if (["replied", "failed", "cancelled", "expired"].includes(state.task.status)) {
      return;
    }
    // 订阅后续增量
    const queue: AgentTaskStreamEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (ev: AgentTaskStreamEvent) => {
      queue.push(ev);
      wake?.();
    };
    state.listeners.add(listener);
    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            // 终态后短暂等一下再退出（收尾事件可能还在路上）
            setTimeout(resolve, 200);
          });
          if (queue.length === 0 && ["replied", "failed", "cancelled", "expired"].includes(state.task.status)) {
            return;
          }
        }
        const ev = queue.shift();
        if (ev) yield ev;
        if (
          ev?.type === "status" &&
          ["replied", "failed", "cancelled", "expired"].includes(ev.task.status)
        ) {
          return;
        }
      }
    } finally {
      state.listeners.delete(listener);
    }
  }
}
