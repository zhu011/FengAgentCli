/**
 * 测试夹具：一个最小的 Claude Code `stream-json` 替身
 *
 * 复刻真机观测到的事件形状（`claude -p --output-format stream-json --verbose`）：
 *
 * ```
 * {"type":"system","subtype":"init","session_id":…,"cwd":…,"claude_code_version":…}
 * {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}
 * {"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}
 * {"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":…}
 * ```
 *
 * 支持的自检标记（与 ACP 夹具同款）：
 * - `--version` → 打印版本（驱动 `initialize()` 用，不产生模型调用）
 * - `ENV_PROBE` / `CWD_PROBE` → 回显目标进程实际拿到的环境/cwd
 * - `FAIL` → `result` 事件带 `is_error:true`（驱动应抛错）
 * - 结果文本里附带 `[argv] …`，便于断言权限/续聊参数确实传下去了
 */

interface ClaudeEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

// 显式标记为模块：否则与其它夹具共享全局作用域（`SESSION_ID` 重复声明）
export {};

const SESSION_ID = "fake-claude-session-1";

function emit(event: ClaudeEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function streamText(text: string): void {
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    session_id: SESSION_ID,
  });
}

function assistantText(text: string): void {
  emit({
    type: "assistant",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "fake-claude",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    session_id: SESSION_ID,
  });
}

function result(text: string, isError: boolean, subtype: string): void {
  emit({
    type: "result",
    subtype,
    is_error: isError,
    result: text,
    session_id: SESSION_ID,
    duration_ms: 5,
    num_turns: 1,
    permission_denials: [],
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) {
    process.stdout.write("9.9.9 (Fake Claude Code)\n");
    return;
  }

  // prompt 走 stdin（与真实现一致）
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  const prompt = chunks.join("");

  emit({
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    cwd: process.cwd(),
    model: "fake-claude",
    tools: ["Bash", "Write", "Read"],
    claude_code_version: "9.9.9",
    permissionMode: argv.includes("bypassPermissions") ? "bypassPermissions" : "default",
  });

  const multicaKeys = Object.keys(process.env)
    .filter((key) => key.toLowerCase().startsWith("multica"))
    .sort();

  if (prompt.includes("ENV_PROBE")) {
    const text = `multica_env=${multicaKeys.length === 0 ? "none" : multicaKeys.join(",")}`;
    streamText(text);
    assistantText(text);
    result(text, false, "success");
    return;
  }
  if (prompt.includes("CWD_PROBE")) {
    const text = `cwd=${process.cwd()}`;
    streamText(text);
    assistantText(text);
    result(text, false, "success");
    return;
  }

  const argvNote = `[argv] ${argv.join(" ")}`;
  streamText("你");
  streamText("好");
  assistantText("你好");
  streamText(argvNote);
  assistantText(argvNote);

  if (prompt.includes("FAIL")) {
    result("目标拒绝执行", true, "error_during_execution");
    return;
  }
  result(`你好${argvNote}`, false, "success");
}

await main();
