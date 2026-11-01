// Tool specs the plugin exposes to the DSH agent. Kept DSH-independent so
// the handlers can be unit-tested; plugin.mjs wraps them with defineTool().
//
// Naming: `fengagent_group_*` prefix keeps the bridge from shadowing (or
// colliding with) any other plugin's `group_*` tools inside one DSH profile.

/** Clip a string for bounded tool output. */
function clip(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

/**
 * @param {ReturnType<typeof import("./api-client.mjs").createFengClient>} client
 */
export function fengGroupToolSpecs(client) {
  return [
    {
      name: "fengagent_group_list",
      description:
        "List FengAgentCli chat groups and the agent runtimes that can be group members. " +
        "Use this before fengagent_group_create to pick valid member runtime names.",
      parameters: {},
      async handler() {
        const r = await client.listGroups();
        const groups = (r.groups ?? []).slice(0, 100).map((g) => ({
          id: g.id,
          name: g.name,
          status: g.status,
          members: g.members ?? [],
        }));
        const runtimes = (r.runtimes ?? []).slice(0, 100).map((t) => ({
          name: t.name,
          enabled: t.enabled,
          probeStatus: t.probeStatus,
        }));
        return { ok: true, id: `${groups.length}g/${runtimes.length}r`, groups, runtimes };
      },
      render: (v) => {
        const g = (v.groups ?? []).map(
          (x) => `group "${x.name}" [${x.status}] id=${x.id} members=${(x.members ?? []).join(", ")}`,
        );
        const r = (v.runtimes ?? []).map(
          (x) => `runtime ${x.name}${x.enabled ? "" : " (disabled)"}${x.probeStatus === "ok" ? "" : ` probe=${x.probeStatus}`}`,
        );
        return [...g, ...r].join("\n") || "no groups, no runtimes";
      },
    },
    {
      name: "fengagent_group_create",
      description:
        "Create a FengAgentCli chat group with agent runtime members. Member names must be " +
        "registered runtimes (unknown names are rejected with 400 — check fengagent_group_list first). " +
        "Returns the group info incl. its id.",
      parameters: {
        name: { type: "string", required: true, description: "Group name" },
        members: {
          type: "array",
          items: { type: "string" },
          required: true,
          description: "Member runtime names (from fengagent_group_list)",
        },
        description: { type: "string", description: "Optional group description / task briefing" },
        maxRounds: { type: "integer", description: "Optional coordinator round cap before auto-conclude" },
        idleTimeoutMs: { type: "integer", description: "Optional idle auto-conclude timeout in ms (default 10 min)" },
      },
      async handler(args) {
        const group = await client.createGroup({
          name: args.name,
          members: args.members ?? [],
          createdBy: "dsh",
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
          ...(args.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: args.idleTimeoutMs }),
        });
        return {
          ok: true,
          id: group.id,
          name: group.name,
          status: group.status,
          members: group.members ?? [],
        };
      },
      render: (v) =>
        `group "${v.name}" created (id=${v.id}, status=${v.status}, members=${(v.members ?? []).join(", ")})`,
    },
    {
      name: "fengagent_group_send",
      description:
        "Send a message into a FengAgentCli group as the human operator — the group's coordinator " +
        'and members react to it. kind="decision" records a final ruling and auto-concludes the group.',
      parameters: {
        groupId: { type: "string", required: true, description: "Group id (from fengagent_group_list / create)" },
        content: { type: "string", required: true, description: "Message text" },
        kind: {
          type: "string",
          enum: ["chat", "decision"],
          description: 'chat (default) or decision (final ruling — concludes the group)',
        },
      },
      async handler(args) {
        const m = await client.sendGroupMessage(args.groupId, {
          content: args.content,
          ...(args.kind === undefined ? {} : { kind: args.kind }),
        });
        return { ok: true, id: m.id, seq: m.seq, fromName: m.fromName, kind: m.kind };
      },
      render: (v) => `#${v.seq} [${v.fromName}] sent${v.kind === "decision" ? " (decision — group concluded)" : ""}`,
    },
    {
      name: "fengagent_group_history",
      description:
        "Read messages from a FengAgentCli group (ascending by seq). Pass after=nextSeq from a " +
        "previous call to poll incrementally; dispatched task results come back as task_card messages. " +
        "Defaults to the first 200 messages when neither after nor limit is given.",
      parameters: {
        groupId: { type: "string", required: true, description: "Group id" },
        after: { type: "integer", description: "Only return messages with seq > after (incremental poll)" },
        limit: { type: "integer", description: "Max messages to return (default 200)" },
      },
      async handler(args) {
        const r = await client.groupHistory(args.groupId, {
          ...(args.after === undefined ? {} : { after: args.after }),
          limit: args.limit ?? 200,
        });
        const messages = r.messages ?? [];
        return {
          ok: true,
          id: String(r.nextSeq ?? 0),
          nextSeq: r.nextSeq ?? 0,
          messages: messages.map((m) => ({
            seq: m.seq,
            fromName: m.fromName,
            fromKind: m.fromKind,
            kind: m.kind,
            content: clip(m.content, 2000),
          })),
        };
      },
      render: (v) => {
        const lines = (v.messages ?? []).map(
          (m) => `#${m.seq} [${m.fromName}]${m.kind && m.kind !== "chat" ? ` <${m.kind}>` : ""} ${m.content}`,
        );
        return lines.join("\n") || `(no messages; nextSeq=${v.nextSeq})`;
      },
    },
    {
      name: "fengagent_group_dispatch",
      description:
        "Dispatch a task to one agent runtime inside a FengAgentCli group (G2). The task result is " +
        "written back to the group as a task_card message automatically — poll fengagent_group_history for it.",
      parameters: {
        groupId: { type: "string", required: true, description: "Group id" },
        runtime: { type: "string", required: true, description: "Target runtime name (from fengagent_group_list)" },
        task: { type: "string", required: true, description: "Task text for the runtime" },
      },
      async handler(args) {
        const t = await client.dispatchTask({
          runtime: args.runtime,
          content: args.task,
          groupId: args.groupId,
          fromSession: "dsh",
        });
        return { ok: true, id: t.id, status: t.status, runtime: t.runtime, groupId: t.groupId ?? args.groupId };
      },
      render: (v) => `task ${v.id} → ${v.runtime} (${v.status}); result will appear in the group`,
    },
  ];
}
