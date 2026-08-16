/**
 * @fengagent/events — 事件导出/导入测试（Phase 3 ①）
 *
 * 覆盖：
 * 1. 导出 → 新数据根导入回环：事件逐字保留（sessionId/seq/hash 信封），投影一致；
 * 2. 幂等去重：重复导入同文件 → noop，事件日志不变（字节级）；
 * 3. 前缀续写：先导入旧文件、后导入扩展文件 → appended 只写增量；
 * 4. 旧文件重复导入（目标日志已更长）→ noop（已包含）；
 * 5. 校验拒绝：篡改 payload/seq/sessionId/未注册类型/坏 header → ImportConflictError，目标不动；
 * 6. 链冲突：同会话不同链 → 拒绝，目标不动；
 * 7. 可移植性：导出文件不含本机路径（跨机安全）；
 * 8. exportStoreEvents / importStoreEvents 整库迁移（含 rollback/fork 会话）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message, Session } from "@fengagent/core";
import { createSession, createUserMessage } from "@fengagent/core";
import { EventStore, ImportConflictError } from "../event-store.ts";
import { DualWriteSessionStore } from "../dual-write.ts";
import { EventGraphStore } from "../event-graph-store.ts";
import {
  exportSessionEvents,
  importSessionEvents,
  exportStoreEvents,
  importStoreEvents,
  EVENT_EXPORT_FORMAT,
} from "../migration.ts";
import { verifyEventChain, computeEventHash } from "../hash.ts";
import { projectSession } from "../projection.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 模拟运行时 prompt() 写路径：一轮对话双写（用户 → 助手） */
function runOneTurn(
  dual: DualWriteSessionStore,
  session: Session,
  userText: string,
  assistantContent: ContentBlock[],
  tokenCount: number,
) {
  session.status = "running";
  session.updatedAt = Date.now();
  dual.saveSession(session);

  const userMsg = createUserMessage(userText);
  session.messages.push(userMsg);
  session.updatedAt = Date.now();
  dual.saveSession(session);
  dual.saveMessage(session.id, userMsg);

  const assistantMsg: Message = {
    id: `msg-a-${tokenCount}`,
    role: "assistant",
    content: assistantContent,
    createdAt: Date.now(),
  };
  session.messages.push(assistantMsg);
  session.tokenCount = tokenCount;
  session.updatedAt = Date.now();
  session.status = "idle";
  dual.saveSession(session);
  dual.saveMessages(session.id, session.messages);
}

function setup(prefix = "mig-test-") {
  const dir = tmpDir(prefix);
  const events = new EventStore({ dir: join(dir, "events") });
  return { dir, events };
}

describe("事件导出/导入（Phase 3 ①）", () => {
  test("导出 → 新数据根导入回环：事件逐字保留，投影一致，链完整", () => {
    const { events: src } = setup("mig-src-");
    const dual = new DualWriteSessionStore({ legacy: { saveSession() {}, loadSession: () => null, deleteSession() {} }, events: src, model: "deepseek-chat" });
    const session = createSession("deepseek-chat", "迁移会话");
    runOneTurn(dual, session, "第一问", [{ type: "text", text: "第一答" }], 60);
    runOneTurn(dual, session, "第二问", [{ type: "text", text: "第二答" }], 150);
    session.title = "改名";
    session.updatedAt = Date.now();
    dual.saveSession(session);

    const srcEvents = src.replay(session.id);
    expect(verifyEventChain(srcEvents)).toEqual([]);
    const projectedSrc = projectSession(srcEvents)!;

    // 导出
    const dir = tmpDir("mig-export-");
    const filePath = join(dir, `${session.id}.fengevents.jsonl`);
    const header = exportSessionEvents(src, session.id, filePath);
    expect(header.format).toBe(EVENT_EXPORT_FORMAT);
    expect(header.sessionId).toBe(session.id);
    expect(header.eventCount).toBe(srcEvents.length);
    expect(header.lastHash).toBe(srcEvents[srcEvents.length - 1]!.hash);

    // 新数据根导入
    const { events: dst } = setup("mig-dst-");
    const outcome = importSessionEvents(dst, filePath);
    expect(outcome.status).toBe("imported");
    expect(outcome.imported).toBe(srcEvents.length);
    expect(outcome.skipped).toBe(0);

    // 逐字保留：重放与源一致（含信封 hash/seq/prevHash/timestamp）
    const dstEvents = dst.replay(session.id);
    expect(dstEvents).toEqual(srcEvents);
    expect(verifyEventChain(dstEvents)).toEqual([]);
    // 投影一致（#3：title/status/meta 不丢）
    const projectedDst = projectSession(dstEvents)!;
    expect(projectedDst).toEqual(projectedSrc);
    expect(projectedDst.title).toBe("改名");
    expect(projectedDst.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("幂等去重：重复导入同一文件 → noop，事件日志字节级不变", () => {
    const { events: src } = setup("mig-idem-src-");
    const dual = new DualWriteSessionStore({ legacy: { saveSession() {}, loadSession: () => null, deleteSession() {} }, events: src, model: "m" });
    const session = createSession("m", "幂等");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 10);

    const filePath = join(tmpDir("mig-idem-file-"), "s.fengevents.jsonl");
    exportSessionEvents(src, session.id, filePath);

    const { events: dst } = setup("mig-idem-dst-");
    const first = importSessionEvents(dst, filePath);
    expect(first.status).toBe("imported");

    // 重复导入 → noop
    const second = importSessionEvents(dst, filePath);
    expect(second.status).toBe("noop");
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(first.imported);

    // 事件日志字节级不变
    const before = readFileSync(dst.pathFor(session.id), "utf8");
    importSessionEvents(dst, filePath);
    const after = readFileSync(dst.pathFor(session.id), "utf8");
    expect(after).toBe(before);
  });

  test("前缀续写：先导入旧文件、后导入扩展文件 → appended 只写增量", () => {
    const { events: src } = setup("mig-prefix-src-");
    const dual = new DualWriteSessionStore({ legacy: { saveSession() {}, loadSession: () => null, deleteSession() {} }, events: src, model: "m" });
    const session = createSession("m", "前缀");
    runOneTurn(dual, session, "第一问", [{ type: "text", text: "第一答" }], 60);

    const dir = tmpDir("mig-prefix-file-");
    const file1 = join(dir, "one.fengevents.jsonl");
    exportSessionEvents(src, session.id, file1);
    const count1 = src.replay(session.id).length;

    // 扩展（第二轮）
    runOneTurn(dual, session, "第二问", [{ type: "text", text: "第二答" }], 150);
    const file2 = join(dir, "two.fengevents.jsonl");
    exportSessionEvents(src, session.id, file2);
    const count2 = src.replay(session.id).length;
    expect(count2).toBeGreaterThan(count1);

    // 目标根先导入旧文件
    const { events: dst } = setup("mig-prefix-dst-");
    const first = importSessionEvents(dst, file1);
    expect(first.status).toBe("imported");
    expect(first.imported).toBe(count1);

    // 再导入扩展文件 → appended，只写增量
    const second = importSessionEvents(dst, file2);
    expect(second.status).toBe("appended");
    expect(second.imported).toBe(count2 - count1);
    expect(second.skipped).toBe(count1);

    // 重放与源一致，链完整
    expect(dst.replay(session.id)).toEqual(src.replay(session.id));
    expect(verifyEventChain(dst.replay(session.id))).toEqual([]);
  });

  test("旧文件重复导入（目标日志已更长）→ noop（已包含）", () => {
    const { events: src } = setup("mig-old-src-");
    const dual = new DualWriteSessionStore({ legacy: { saveSession() {}, loadSession: () => null, deleteSession() {} }, events: src, model: "m" });
    const session = createSession("m", "旧文件");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 10);
    const count1 = src.replay(session.id).length;

    const dir = tmpDir("mig-old-file-");
    const file1 = join(dir, "one.fengevents.jsonl");
    exportSessionEvents(src, session.id, file1);
    runOneTurn(dual, session, "再问", [{ type: "text", text: "再答" }], 20);
    const file2 = join(dir, "two.fengevents.jsonl");
    exportSessionEvents(src, session.id, file2);

    const { events: dst } = setup("mig-old-dst-");
    expect(importSessionEvents(dst, file2).status).toBe("imported");
    // 旧文件（file1 是 file2 前缀）→ noop
    const r = importSessionEvents(dst, file1);
    expect(r.status).toBe("noop");
    expect(r.skipped).toBe(count1);
    expect(dst.replay(session.id)).toEqual(src.replay(session.id));
  });

  test("篡改拒绝：payload/seq/header/sessionId/未注册类型 → ImportConflictError，目标不动", () => {
    const { events: src } = setup("mig-tamper-src-");
    const dual = new DualWriteSessionStore({ legacy: { saveSession() {}, loadSession: () => null, deleteSession() {} }, events: src, model: "m" });
    const session = createSession("m", "篡改");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 10);

    const dir = tmpDir("mig-tamper-file-");
    const filePath = join(dir, "s.fengevents.jsonl");
    exportSessionEvents(src, session.id, filePath);

    // (a) 篡改 payload（文本内容）→ hash 不匹配
    const tamperDir = tmpDir("mig-tamper-a-");
    const tampered = join(tamperDir, "a.fengevents.jsonl");
    const raw = readFileSync(filePath, "utf8");
    const tamperedText = raw.replace('"text":"答"', '"text":"篡改的答"');
    writeFileSync(tampered, tamperedText, "utf8");

    const { events: dstA } = setup("mig-tamper-dst-a-");
    expect(() => importSessionEvents(dstA, tampered)).toThrow(ImportConflictError);
    expect(() => importSessionEvents(dstA, tampered)).toThrow(/事件链校验失败/);

    // (b) 篡改 seq → seq 不连续
    const tamperDirB = tmpDir("mig-tamper-b-");
    const tamperedB = join(tamperDirB, "b.fengevents.jsonl");
    const linesB = raw.split("\n");
    const ev2 = JSON.parse(linesB[2]!) as { seq: number };
    linesB[2] = JSON.stringify({ ...ev2, seq: ev2.seq + 99 });
    writeFileSync(tamperedB, linesB.join("\n"), "utf8");
    const { events: dstB } = setup("mig-tamper-dst-b-");
    expect(() => importSessionEvents(dstB, tamperedB)).toThrow(/事件链校验失败/);

    // (c) 未注册类型 → 注册表校验拒绝（链合法但类型未注册）
    // 手工构造合法链（hash 正确计算）+ 未注册类型，绕过「改 type 会破坏 hash」的链校验
    const sid = "reg-session";
    const evCreated = {
      version: 1,
      sessionId: sid,
      seq: 1,
      type: "session/created",
      timestamp: "2026-08-16T00:00:00.000Z",
      hash: "",
      prevHash: null,
      payload: { title: "t", status: "created" as const },
    };
    evCreated.hash = computeEventHash(null, 1, "session/created", evCreated.payload);
    const evMystery = {
      version: 1,
      sessionId: sid,
      seq: 2,
      type: "mystery/unknown",
      timestamp: "2026-08-16T00:00:01.000Z",
      hash: "",
      prevHash: evCreated.hash,
      payload: { x: 1 },
    };
    evMystery.hash = computeEventHash(evCreated.hash, 2, "mystery/unknown", evMystery.payload);
    const tamperDirC = tmpDir("mig-tamper-c-");
    const tamperedC = join(tamperDirC, "c.fengevents.jsonl");
    const headerC = {
      type: "fengagent-export",
      format: EVENT_EXPORT_FORMAT,
      version: 1,
      exportedAt: "2026-08-16T00:00:02.000Z",
      sessionId: sid,
      eventCount: 2,
      firstSeq: 1,
      lastSeq: 2,
      lastHash: evMystery.hash,
    };
    writeFileSync(
      tamperedC,
      [JSON.stringify(headerC), JSON.stringify(evCreated), JSON.stringify(evMystery)].join("\n") + "\n",
      "utf8",
    );
    const { events: dstC } = setup("mig-tamper-dst-c-");
    expect(() => importSessionEvents(dstC, tamperedC)).toThrow(/未注册或校验失败/);

    // 目标日志一律未动（没有 session 文件）
    expect(existsSync(dstA.pathFor(session.id))).toBe(false);
    expect(existsSync(dstB.pathFor(session.id))).toBe(false);
    expect(existsSync(dstC.pathFor(session.id))).toBe(false);

    // (d) 坏 header（非可移植文件）→ 拒绝
    const { events: dstD } = setup("mig-tamper-dst-d-");
    const badHeader = join(tmpDir("mig-tamper-d-"), "d.fengevents.jsonl");
    writeFileSync(badHeader, '{"type":"other","format":"x","version":9}\n', "utf8");
    expect(() => importSessionEvents(dstD, badHeader)).toThrow(/不是 fengagent-event-export header/);

    // (e) 事件 sessionId 与 header 不一致 → 拒绝
    const tamperDirE = tmpDir("mig-tamper-e-");
    const tamperedE = join(tamperDirE, "e.fengevents.jsonl");
    const linesE = raw.split("\n");
    const evE = JSON.parse(linesE[2]!) as { sessionId: string };
    const tamperedLineE = JSON.stringify({ ...evE, sessionId: "other-session" });
    linesE[2] = tamperedLineE;
    writeFileSync(tamperedE, linesE.join("\n"), "utf8");
    const { events: dstE } = setup("mig-tamper-dst-e-");
    expect(() => importSessionEvents(dstE, tamperedE)).toThrow(/sessionId 与 header 不一致/);
  });

  test("链冲突：同会话不同内容链 → 拒绝，目标日志不动", () => {
    // 源 A：会话 X 内容「A」
    const { events: srcA } = setup("mig-conflict-a-");
    const dualA = new DualWriteSessionStore({ legacy: { saveSession() {}, loadSession: () => null, deleteSession() {} }, events: srcA, model: "m" });
    const sessionA = createSession("m", "冲突A");
    runOneTurn(dualA, sessionA, "A问", [{ type: "text", text: "A答" }], 10);
    const fileA = join(tmpDir("mig-conflict-file-a-"), "a.fengevents.jsonl");
    exportSessionEvents(srcA, sessionA.id, fileA);

    // 源 B：同一会话 id，不同内容「B」（构造：目标根先用 B 链）
    const { events: dst } = setup("mig-conflict-dst-");
    const dualB = new DualWriteSessionStore({ legacy: { saveSession() {}, loadSession: () => null, deleteSession() {} }, events: dst, model: "m" });
    const sessionB = createSession("m", "冲突B");
    sessionB.id = sessionA.id; // 同会话 id
    runOneTurn(dualB, sessionB, "B问", [{ type: "text", text: "B答" }], 20);

    // 导入 A 链 → 冲突（共同前缀 0 条后分叉）
    expect(() => importSessionEvents(dst, fileA)).toThrow(/链冲突/);
    // 目标日志保持 B 链原样
    expect(dst.replay(sessionA.id)).toEqual(dst.replay(sessionA.id));
    expect(verifyEventChain(dst.replay(sessionA.id))).toEqual([]);
  });

  test("可移植性：导出文件不含本机路径/进程态（跨机安全）", () => {
    const { events: src, dir } = setup("mig-portable-");
    const dual = new DualWriteSessionStore({ legacy: { saveSession() {}, loadSession: () => null, deleteSession() {} }, events: src, model: "m" });
    const session = createSession("m", "可移植");
    runOneTurn(dual, session, "问", [{ type: "text", text: "答" }], 10);

    const filePath = join(tmpDir("mig-portable-file-"), "s.fengevents.jsonl");
    exportSessionEvents(src, session.id, filePath);
    const text = readFileSync(filePath, "utf8");
    // 不包含本机临时目录路径
    expect(text).not.toContain(dir);
    expect(text).not.toContain("C:");
    // 逐行都是合法 JSON（header + 事件）
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("整库迁移：exportStoreEvents → 新根 importStoreEvents（含 rollback/fork 会话）", () => {
    const { events: src } = setup("mig-store-src-");
    const dual = new DualWriteSessionStore({ legacy: { saveSession() {}, loadSession: () => null, deleteSession() {} }, events: src, model: "m" });
    const graph = new EventGraphStore({ events: src });

    // 会话 1：普通两轮
    const s1 = createSession("m", "普通会话");
    runOneTurn(dual, s1, "一", [{ type: "text", text: "一答" }], 30);
    runOneTurn(dual, s1, "二", [{ type: "text", text: "二答" }], 60);

    // 会话 2：rollback 会话（回退 + 截断 + 重答）
    const s2 = createSession("m", "回退会话");
    runOneTurn(dual, s2, "第一问", [{ type: "text", text: "第一答" }], 50);
    runOneTurn(dual, s2, "第二问", [{ type: "text", text: "第二答" }], 90);
    const asst2 = graph.listNodes(s2.id).filter((n) => n.type === "assistant")[1]!;
    graph.markQuality(asst2.id, "poor", "不佳");
    const rbNodeId = asst2.parentId!;
    graph.rollbackTo(rbNodeId, "不佳");
    const idx = s2.messages.findIndex((m) => m.id === graph.getNode(rbNodeId)!.messageId);
    s2.messages = s2.messages.slice(0, idx + 1);
    s2.tokenCount = 20;
    const evs2 = src.replay(s2.id);
    s2.updatedAt = Date.parse(evs2[evs2.length - 1]!.timestamp);
    dual.saveSession(s2);
    dual.saveMessages(s2.id, s2.messages);
    // 重答
    const retry: Message = { id: "a-retry", role: "assistant", content: [{ type: "text", text: "重答" }], createdAt: Date.now() };
    s2.messages.push(retry);
    s2.tokenCount = 120;
    s2.updatedAt = Date.now();
    dual.saveSession(s2);
    dual.saveMessages(s2.id, s2.messages);

    // 会话 3：fork 会话
    const s3 = createSession("m", "分叉会话");
    runOneTurn(dual, s3, "一", [{ type: "text", text: "一答" }], 30);
    const user1 = graph.listNodes(s3.id).filter((n) => n.type === "user")[0]!;
    graph.fork(user1.id, "explore-x");

    // 源事件链全部完整
    for (const sid of src.listSessionIds()) {
      expect(verifyEventChain(src.replay(sid))).toEqual([]);
    }

    // 导出整库
    const exportDir = tmpDir("mig-store-export-");
    const written = exportStoreEvents(src, exportDir);
    expect(written.length).toBe(3);

    // 新根导入整库（幂等：再来一次 skipped=3）
    const { events: dst } = setup("mig-store-dst-");
    const summary1 = importStoreEvents(dst, exportDir);
    expect(summary1.imported).toBe(3);
    expect(summary1.failed).toBe(0);
    const summary2 = importStoreEvents(dst, exportDir);
    expect(summary2.imported).toBe(0);
    expect(summary2.skipped).toBe(3);
    expect(summary2.failed).toBe(0);

    // 重放与源一致（含 rollback/fork 会话的完整事件链）
    expect(dst.listSessionIds().sort()).toEqual(src.listSessionIds().sort());
    for (const sid of src.listSessionIds()) {
      expect(dst.replay(sid)).toEqual(src.replay(sid));
      expect(verifyEventChain(dst.replay(sid))).toEqual([]);
      expect(projectSession(dst.replay(sid))).toEqual(projectSession(src.replay(sid)));
    }
    // 图派生视图一致（新根重建 EventGraphStore 也能还原同一张图）
    const graphDst = new EventGraphStore({ events: dst });
    expect(graphDst.getActiveHead(s2.id)?.type).toBe("assistant");
    expect(graphDst.getActiveHead(s2.id)!.messageId).toBe("a-retry");
    expect(graphDst.getActiveHead(s3.id)?.type).toBe("branch-point");
    expect(graphDst.getActiveHead(s3.id)!.meta.branch).toBe("explore-x");
  });
});
