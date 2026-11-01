// Unit tests for the bridge — run against an in-process fake of the
// FengAgentCli server surface. No DSH install required:
//   cd integrations/fengagent-groups && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeFengServer } from "./fake-feng-server.mjs";
import { createFengClient, FengError } from "../src/api-client.mjs";
import { fengGroupToolSpecs } from "../src/tools.mjs";
import { resolveConfig, ConfigError } from "../src/config.mjs";

function specsAt(url) {
  return fengGroupToolSpecs(createFengClient({ serverUrl: url, timeoutMs: 3000 }));
}

test("config — defaults, env override, unknown key, bad URL", () => {
  assert.deepEqual(resolveConfig(), { serverUrl: "http://127.0.0.1:3000", timeoutMs: 30_000 });
  assert.equal(resolveConfig({}, { FENG_SERVER_URL: "http://10.0.0.5:9000/" }).serverUrl, "http://10.0.0.5:9000");
  assert.equal(resolveConfig({ serverUrl: "http://x:1/" }).serverUrl, "http://x:1");
  assert.equal(resolveConfig({ timeoutMs: 5000 }).timeoutMs, 5000);
  assert.throws(() => resolveConfig({ nope: 1 }), ConfigError);
  assert.throws(() => resolveConfig({ serverUrl: "ftp://x" }), ConfigError);
});

test("group_list — maps groups + runtimes", async () => {
  const fx = await startFakeFengServer();
  try {
    const tool = specsAt(fx.url).find((s) => s.name === "fengagent_group_list");
    const out = await tool.handler({});
    assert.equal(out.ok, true);
    assert.deepEqual(out.runtimes.map((r) => r.name), ["fengagent", "claude"]);
    assert.equal(out.groups.length, 0);
    assert.match(tool.render(out), /runtime fengagent/);
  } finally {
    fx.server.close();
  }
});

test("group_create — posts name/members/createdBy, returns group card", async () => {
  const fx = await startFakeFengServer();
  try {
    const tool = specsAt(fx.url).find((s) => s.name === "fengagent_group_create");
    const out = await tool.handler({ name: "攻坚组", members: ["fengagent", "claude"], maxRounds: 5 });
    assert.equal(out.ok, true);
    assert.equal(out.name, "攻坚组");
    assert.deepEqual(out.members, ["fengagent", "claude"]);
    const req = fx.requests.find((r) => r.method === "POST" && r.path === "/api/groups");
    assert.deepEqual(req.body, {
      name: "攻坚组",
      members: ["fengagent", "claude"],
      createdBy: "dsh",
      maxRounds: 5,
    });
  } finally {
    fx.server.close();
  }
});

test("group_create — unknown member surfaces the server error", async () => {
  const fx = await startFakeFengServer();
  try {
    const tool = specsAt(fx.url).find((s) => s.name === "fengagent_group_create");
    await assert.rejects(
      () => tool.handler({ name: "x", members: ["nobody"] }),
      (err) => err instanceof FengError && err.status === 400 && /未注册/.test(err.message),
    );
  } finally {
    fx.server.close();
  }
});

test("group_send + group_history — decision concludes; incremental poll via nextSeq", async () => {
  const fx = await startFakeFengServer();
  try {
    const specs = specsAt(fx.url);
    const byName = (n) => specs.find((s) => s.name === n);
    const group = await byName("fengagent_group_create").handler({ name: "g", members: ["claude"] });

    const sent = await byName("fengagent_group_send").handler({
      groupId: group.id,
      content: "各位，开始分析",
    });
    assert.equal(sent.seq, 1);
    assert.equal(sent.fromName, "human");
    const sendReq = fx.requests.find((r) => r.method === "POST" && r.path === `/api/groups/${group.id}/messages`);
    assert.deepEqual(sendReq.body, { content: "各位，开始分析" });

    const hist = await byName("fengagent_group_history").handler({ groupId: group.id });
    assert.equal(hist.nextSeq, 1);
    assert.equal(hist.messages[0].content, "各位，开始分析");

    // 增量：after=nextSeq 之后为空，nextSeq 保持
    const hist2 = await byName("fengagent_group_history").handler({ groupId: group.id, after: hist.nextSeq });
    assert.equal(hist2.messages.length, 0);
    assert.equal(hist2.nextSeq, 1);
    assert.match(byName("fengagent_group_history").render(hist2), /no messages/);

    const decision = await byName("fengagent_group_send").handler({
      groupId: group.id,
      content: "就按 A 方案",
      kind: "decision",
    });
    assert.equal(decision.kind, "decision");
    assert.match(byName("fengagent_group_send").render(decision), /decision — group concluded/);
    // 收口后再发言 → 409 冲突以服务器错误浮出
    await assert.rejects(
      () => byName("fengagent_group_send").handler({ groupId: group.id, content: "还有人吗" }),
      (err) => err instanceof FengError && err.status === 409,
    );
  } finally {
    fx.server.close();
  }
});

test("group_dispatch — posts runtime/content/groupId, task echoes back", async () => {
  const fx = await startFakeFengServer();
  try {
    const specs = specsAt(fx.url);
    const group = await specs.find((s) => s.name === "fengagent_group_create").handler({
      name: "g",
      members: ["claude"],
    });
    const tool = specs.find((s) => s.name === "fengagent_group_dispatch");
    const out = await tool.handler({ groupId: group.id, runtime: "claude", task: "读 README 并总结" });
    assert.equal(out.ok, true);
    assert.equal(out.runtime, "claude");
    assert.equal(out.status, "dispatched");
    assert.equal(out.groupId, group.id);
    const req = fx.requests.find((r) => r.method === "POST" && r.path === "/api/agent-tasks");
    assert.deepEqual(req.body, {
      runtime: "claude",
      content: "读 README 并总结",
      groupId: group.id,
      fromSession: "dsh",
    });
    assert.match(tool.render(out), /result will appear in the group/);
  } finally {
    fx.server.close();
  }
});

test("api-client — agent-tasks plain-string error unwraps too", async () => {
  const fx = await startFakeFengServer();
  try {
    const client = createFengClient({ serverUrl: fx.url, timeoutMs: 3000 });
    await assert.rejects(
      () => client.dispatchTask({ runtime: "", content: "x" }),
      (err) => err instanceof FengError && err.message === "runtime 必填",
    );
  } finally {
    fx.server.close();
  }
});
