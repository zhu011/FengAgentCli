/**
 * 统一运行索引（P0）测试：会话 / 派单 / 群聊三路聚合、过滤、分页、消息拍平。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentGroupStore } from "../agent-group-store.ts";
import { AgentTaskStore } from "../agent-task-store.ts";
import { RunIndex } from "../run-index.ts";
import { SessionStore } from "../session.ts";
import { createSession, createUserMessage } from "@fengagent/core";

let root: string;
let taskStore: AgentTaskStore;
let sessionStore: SessionStore;
let groupStore: AgentGroupStore;
let index: RunIndex;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-run-index-"));
  taskStore = new AgentTaskStore(join(root, "agent-tasks.db"));
  sessionStore = new SessionStore(join(root, "sessions.db"));
  groupStore = new AgentGroupStore(join(root, "groups.db"));
  index = new RunIndex({ dataRoot: root });
});

afterEach(() => {
  index.close();
  taskStore.close();
  sessionStore.close();
  groupStore.close();
  // Windows 上 SQLite 句柄释放有延迟：清理失败不算断言失败
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(30);
    }
  }
});

/** 造一条已回复的派单 */
function seedDispatch(content: string, agentId = "coder", runtime = "claude"): string {
  const at = Date.now();
  const { task } = taskStore.create({
    runtime,
    agentId,
    content,
    cwd: root,
    at,
  });
  taskStore.setStatus(task.id, "dispatched", {}, at + 10);
  taskStore.appendEvent(task.id, "task/stream-chunk", "流式片段", at + 20);
  taskStore.appendEvent(task.id, "task/stream-chunk", "拼起来", at + 21);
  taskStore.setStatus(task.id, "replied", { result: "流式片段拼起来" }, at + 30);
  return task.id;
}

describe("RunIndex — 三路 UNION", () => {
  test("按 agent 看到 session / dispatch / group 三类记录", () => {
    const taskId = seedDispatch("把这段代码重构一下");

    const session = createSession("claude", "重构讨论", "coder");
    session.tokenCount = 12;
    sessionStore.saveSession(session);
    sessionStore.saveMessage(session.id, createUserMessage("帮我看看这个函数"));
    session.updatedAt += 1000;
    sessionStore.saveSession(session);

    const group = groupStore.create({ name: "前端小队" });
    groupStore.appendMessage({
      groupId: group.id,
      content: "我先看一下依赖",
      fromKind: "runtime",
      fromName: "claude",
    });

    const page = index.list({ agentId: "coder", runtime: "claude" });
    expect(page.runs.length).toBe(3);
    const kinds = page.runs.map((run) => run.kind).sort();
    expect(kinds).toEqual(["dispatch", "group", "session"]);

    const dispatch = page.runs.find((run) => run.kind === "dispatch")!;
    expect(dispatch.id).toBe(`dispatch:${taskId}`);
    expect(dispatch.status).toBe("completed");
    expect(dispatch.agentId).toBe("coder");
    expect(dispatch.durationMs).toBeGreaterThan(0);
    expect(dispatch.title).toContain("重构");

    const sessionRun = page.runs.find((run) => run.kind === "session")!;
    expect(sessionRun.status).toBe("completed");
    expect(sessionRun.usage?.tokens).toBe(12);
  });

  test("kind / status 过滤 + keyset 分页", () => {
    seedDispatch("任务一");
    seedDispatch("任务二");
    const session = createSession("claude", "会话", "coder");
    sessionStore.saveSession(session);

    const onlyDispatch = index.list({ agentId: "coder", runtime: "claude", kind: "dispatch" });
    expect(onlyDispatch.runs.every((run) => run.kind === "dispatch")).toBe(true);

    const onlySession = index.list({ agentId: "coder", runtime: "claude", kind: ["session"] });
    expect(onlySession.runs.map((run) => run.kind)).toEqual(["session"]);

    const first = index.list({ agentId: "coder", runtime: "claude", limit: 1 });
    expect(first.runs.length).toBe(1);
    expect(first.nextCursor).toBeDefined();
    const second = index.list({
      agentId: "coder",
      runtime: "claude",
      limit: 10,
      cursor: first.nextCursor!,
    });
    const ids = new Set([...first.runs, ...second.runs].map((run) => run.id));
    expect(ids.size).toBe(first.runs.length + second.runs.length);
  });

  test("老派单没有 agent_id 时按 runtime 归属；解绑后只剩新归属", () => {
    // 直接写一行老数据（agent_id = NULL）
    const legacy = taskStore.create({ runtime: "dsh", content: "老任务", cwd: root });
    const page = index.list({ agentId: "coder", runtime: "dsh" });
    expect(page.runs.map((run) => run.id)).toContain(`dispatch:${legacy.task.id}`);
    // 不传 runtime 时老任务不归属任何 agent
    expect(index.list({ agentId: "coder", runtime: null }).runs).toEqual([]);
  });

  test("派单消息：流式片段聚合成一条 assistant 文本 + 权限事件单列", () => {
    const id = seedDispatch("跑一下测试");
    taskStore.appendEvent(id, "task/stream-chunk", "[permission] bash → deny");
    const messages = index.messages(`dispatch:${id}`);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const text = messages.find((message) => message.type === "text")!;
    expect(text.content).toContain("流式片段拼起来");
    // 不重复追加 result（chunk 已覆盖）
    expect(messages.filter((message) => message.type === "text").length).toBe(1);
    expect(messages.some((message) => message.content.startsWith("[permission]"))).toBe(true);
  });

  test("会话消息：ContentBlock 拍平，工具调用按 call_id 配对", () => {
    const session = createSession("claude", "工具会话", "coder");
    sessionStore.saveSession(session);
    const at = Date.now();
    sessionStore.saveMessage(session.id, {
      id: "m1",
      role: "assistant",
      createdAt: at,
      content: [
        { type: "text", text: "我来读文件" },
        { type: "tool-use", id: "call_1", name: "file-read", input: { path: "a.ts" } },
      ],
    });
    sessionStore.saveMessage(session.id, {
      id: "m2",
      role: "user",
      createdAt: at + 1,
      content: [{ type: "tool-result", toolUseId: "call_1", content: "file body" }],
    });

    const messages = index.messages(`session:${session.id}`);
    expect(messages.map((message) => message.type)).toEqual([
      "text",
      "tool_use",
      "tool_result",
    ]);
    expect(messages[1]!.tool).toBe("file-read");
    expect(messages[2]!.callId).toBe("call_1");
    // since 增量
    const after = index.messages(`session:${session.id}`, 2);
    expect(after.map((message) => message.seq)).toEqual([3]);
  });

  test("不存在的 run 返回 null + 空消息，不抛错", () => {
    expect(index.get("dispatch:nope")).toBeNull();
    expect(index.messages("session:nope")).toEqual([]);
    expect(index.get("group:nope")).toBeNull();
  });
});
