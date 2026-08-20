/**
 * @fengagent/cli — TUI 主应用组件
 *
 * 管理 Agent 实例和会话状态，渲染对话视图、输入框、状态栏。
 * 处理 AgentEvent 流并更新 UI。
 */

import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Agent } from "@fengagent/agent";
import type { Session, Message, AgentEvent } from "@fengagent/core";
import { ChatView } from "./chat-view.tsx";
import { Input } from "./input.tsx";
import { StatusBar } from "./status-bar.tsx";
import { ThinkingPet } from "./thinking-pet.tsx";
import {
  handleCommand,
  buildModelListMessage,
  type CommandContext,
} from "../commands.ts";
import type { ToolCallInfo } from "./tool-view.tsx";
import {
  PermissionDialog,
  usePermissionRequester,
} from "./permission-dialog.tsx";
import { theme } from "./theme.ts";

export interface AppProps {
  /** Agent 实例 */
  agent: Agent;
  /** 初始会话（恢复已有或新建） */
  initialSession?: Session;
  /** 退出回调 */
  onExit: () => void;
}

/** UI 状态 */
interface UiState {
  status: "idle" | "running" | "error" | "compacting";
  streamingText: string;
  toolCalls: ToolCallInfo[];
  tokenCount: number;
  inputTokens: number;
  outputTokens: number;
  systemMessages: string[];
}

/** 最大保留的系统消息数 */
const MAX_SYSTEM_MESSAGES = 3;

/**
 * 主应用组件。
 *
 * 管理：
 * - 会话状态（当前会话、模型）
 * - Agent 运行状态和流式事件
 * - 命令解析
 * - UI 布局
 */
export function App({
  agent,
  initialSession,
  onExit,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout: stdoutStream } = useStdout();
  const config = agent.getConfig();

  // 会话状态
  const [session, setSession] = useState<Session>(
    initialSession ?? agent.createSession("New Session"),
  );
  const [model, setModel] = useState(config.model);
  const [messages, setMessages] = useState<Message[]>(
    initialSession?.messages ?? [],
  );

  // UI 状态
  const [ui, setUi] = useState<UiState>({
    status: "idle",
    streamingText: "",
    toolCalls: [],
    tokenCount: session.tokenCount,
    inputTokens: 0,
    outputTokens: 0,
    systemMessages: [],
  });

  // 用于中断运行中的 Agent
  const abortRef = useRef<boolean>(false);

  // 权限审批请求器
  const { pendingRequest, requestPermission, respond, clear: clearPermission } =
    usePermissionRequester();

  /** 添加系统消息 */
  const addSystemMessage = useCallback((msg: string) => {
    setUi((prev) => ({
      ...prev,
      systemMessages: [
        ...prev.systemMessages.slice(-MAX_SYSTEM_MESSAGES + 1),
        msg,
      ],
    }));
  }, []);

  /** 处理用户输入 */
  const handleSubmit = useCallback(
    async (text: string) => {
      // 检查是否为 slash 命令
      if (text.startsWith("/")) {
        const ctx: CommandContext = {
          agent,
          currentSession: session,
          currentModel: model,
        };
        const result = handleCommand(text, ctx);

        if (!result.handled) {
          return;
        }

        // /model list — 异步构建真实模型列表（openai-compatible 尝试拉取 /models）
        if (result.message === "__MODEL_LIST__") {
          try {
            const listText = await buildModelListMessage(ctx);
            addSystemMessage(listText);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            addSystemMessage(`获取模型列表失败: ${message}`);
          }
          return;
        }

        if (result.message) {
          addSystemMessage(result.message);
        }

        if (result.shouldExit) {
          onExit();
          exit();
          return;
        }

        if (result.shouldClear) {
          setUi((prev) => ({ ...prev, systemMessages: [] }));
          // 清屏：用 stdout 写入 ANSI 清屏序列
          stdoutStream.write("\x1b[2J\x1b[H");
          return;
        }

        // /clear context — 清空当前会话的消息历史
        if (result.shouldClearContext) {
          if (session) {
            const clearedSession = { ...session, messages: [], tokenCount: 0, updatedAt: Date.now() };
            setSession(clearedSession);
            setMessages([]);
            setUi((prev) => ({ ...prev, tokenCount: 0 }));
          }
          return;
        }

        // /compact — 异步压缩（需要调用 Agent.compactSession）
        if (result.message === "__COMPACT__") {
          if (session) {
            setUi((prev) => ({ ...prev, status: "compacting" }));
            try {
              const result = await agent.compactSession(session);
              addSystemMessage(
                `上下文已压缩 ✅\n` +
                `  摘要: ${result.summary.slice(0, 100)}${result.summary.length > 100 ? "..." : ""}\n` +
                `  保留近期消息: ${result.recentCount} 条\n` +
                `  Token: ${result.beforeTokens} → ${result.afterTokens} (减少 ${result.beforeTokens - result.afterTokens})`
              );
              setSession({ ...session });
              setMessages([...session.messages]);
              setUi((prev) => ({ ...prev, status: "idle", tokenCount: session.tokenCount }));
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              addSystemMessage(`压缩失败: ${message}`);
              setUi((prev) => ({ ...prev, status: "idle" }));
            }
          }
          return;
        }

        if (result.newSession) {
          setSession(result.newSession);
          setMessages(result.newSession.messages);
          setUi((prev) => ({
            ...prev,
            tokenCount: result.newSession!.tokenCount,
          }));
        }

        if (result.newModel) {
          setModel(result.newModel);
          // 更新当前会话的模型
          setSession((prev) => ({ ...prev, model: result.newModel! }));
        }

        return;
      }

      // 普通：发送消息给 Agent
      if (ui.status === "running") {
        addSystemMessage("Agent 正在运行中，请等待完成后再发送消息。");
        return;
      }

      // 立即将用户消息加入 UI（不等 Agent 响应）
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage]);

      // 重置状态
      abortRef.current = false;
      setUi((prev) => ({
        ...prev,
        status: "running",
        streamingText: "",
        toolCalls: [],
        systemMessages: [],
      }));

      try {
        // 运行 Agent，传入当前会话和权限回调
        const gen = agent.prompt(text, session, { requestPermission });

        for await (const event of gen) {
          if (abortRef.current) {
            break;
          }

          handleAgentEvent(event, {
            setUi,
            setMessages,
            session,
          });
        }

        // 运行结束 — 更新最终状态
        setUi((prev) => ({
          ...prev,
          status: abortRef.current ? "idle" : "idle",
          streamingText: "",
          toolCalls: [],
          tokenCount: session.tokenCount,
        }));

        // 更新消息列表（session.messages 已被 loop 修改）
        setMessages([...session.messages]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setUi((prev) => ({
          ...prev,
          status: "error",
          streamingText: "",
        }));
        addSystemMessage(`错误: ${message}`);
      }
    },
    [agent, session, model, ui.status, exit, onExit, addSystemMessage, stdoutStream, requestPermission],
  );

  /** Ctrl+C 退出 / Ctrl+D 中断运行 */
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (ui.status === "running") {
        // 中断当前运行
        abortRef.current = true;
        clearPermission();
        addSystemMessage("已中断当前运行。");
        setUi((prev) => ({
          ...prev,
          status: "idle",
          streamingText: "",
        }));
      } else {
        // 退出
        onExit();
        exit();
      }
    }
  });

  return (
    <Box flexDirection="column" height={stdoutStream.rows || 24}>
      {/* 标题栏：有消息时单行无边框，无消息时完整欢迎大卡片 */}
      {messages.length === 0 && ui.streamingText === "" && ui.systemMessages.length === 0 ? (
        <Box flexDirection="row" justifyContent="center" marginBottom={0}>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.border}
            paddingX={3}
            paddingY={1}
            width={56}
          >
            <Box flexDirection="row" justifyContent="center" alignItems="center">
              <Text bold color={theme.brand}>⚡ FENGAGENTCLI</Text>
              <Text backgroundColor={theme.backgroundElement} color={theme.brandBright} bold>
                {" v0.1.0 "}
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="center">
              <Text color={theme.text}>开源本地 AI Agent 编程工具</Text>
            </Box>
            <Box flexDirection="row" justifyContent="center">
              <Text color={theme.dim}>CLI · TUI · Web · Multi-Agent · MCP</Text>
            </Box>
            <Text> </Text>
            <Box flexDirection="row" justifyContent="center">
              <Box width={18}><Text color={theme.brand}>🗣  对话</Text></Box>
              <Box width={18}><Text color={theme.brand}>🔧  工具</Text></Box>
              <Box width={18}><Text color={theme.brand}>🤖  多Agent</Text></Box>
            </Box>
            <Box flexDirection="row" justifyContent="center">
              <Box width={18}><Text color={theme.brand}>🧠  记忆</Text></Box>
              <Box width={18}><Text color={theme.brand}>⚡  MCP</Text></Box>
              <Box width={18}><Text color={theme.brand}>🎨  WebUI</Text></Box>
            </Box>
            <Text> </Text>
            <Box flexDirection="row" justifyContent="center">
              <Text color={theme.border}>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
            </Box>
            <Text> </Text>
            <Box flexDirection="row" justifyContent="center">
              <Text color={theme.text}>📝  输入问题开始对话</Text>
            </Box>
            <Box flexDirection="row" justifyContent="center">
              <Text color={theme.dim}>❓  /help 查看帮助 · /model 切换模型 · /provider 配置</Text>
            </Box>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="row" justifyContent="center" marginBottom={0}>
          <Text bold color={theme.brand}>⚡ FENGAGENTCLI</Text>
          <Text color={theme.subtle}> · v0.1.0</Text>
        </Box>
      )}

      {/* 对话区域（占满剩余空间，flexShrink 让出高度给补全列表）
          注意：必须 flexBasis={0} + minHeight={0}，否则消息内容很长时
          该区域按内容固有高度参与布局，会把宠物/输入框/状态栏挤出屏幕 */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
        width="100%"
        overflowY="hidden"
      >
        {/* 系统消息（命令输出等） */}
        {ui.systemMessages.length > 0 && (
          <Box flexDirection="column" width="100%" marginBottom={1}>
            {ui.systemMessages.map((msg, i) => (
              <Box key={i} flexDirection="column" borderStyle="round" borderColor={theme.subtle} paddingX={1}>
                <Text color={theme.dim} wrap="truncate">
                  {msg}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {/* 对话视图 */}
        <ChatView
          messages={messages}
          streamingText={ui.streamingText}
          toolCalls={ui.toolCalls}
          isRunning={ui.status === "running"}
        />
      </Box>

      {/* 思考动画宠物 — AI 运行中且无流式文本时显示 */}
      {ui.status === "running" && ui.streamingText === "" && !pendingRequest && (
        <Box paddingX={1} marginBottom={0}>
          <ThinkingPet text={ui.toolCalls.length > 0 ? "执行工具中" : "思考中"} />
        </Box>
      )}

      {/* 权限审批对话框（工具需要用户审批时显示） */}
      {pendingRequest && (
        <PermissionDialog
          request={pendingRequest}
          onRespond={respond}
        />
      )}

      {/* 输入框 */}
      <Input
        onSubmit={handleSubmit}
        disabled={ui.status === "running"}
      />

      {/* 状态栏 */}
      <StatusBar
        model={model}
        tokenCount={ui.tokenCount}
        status={ui.status}
        sessionId={session.id}
        contextWindow={config.contextWindow}
      />
    </Box>
  );
}

// ──────────────────────────────────────────────
// AgentEvent 处理
// ──────────────────────────────────────────────

interface EventHandlerContext {
  setUi: React.Dispatch<React.SetStateAction<UiState>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  session: Session;
}

/** 处理单个 AgentEvent，更新 UI 状态 */
function handleAgentEvent(
  event: AgentEvent,
  ctx: EventHandlerContext,
): void {
  const { setUi } = ctx;

  switch (event.type) {
    case "session-start":
      // 更新会话信息
      setUi((prev) => ({
        ...prev,
        tokenCount: event.session.tokenCount,
      }));
      break;

    case "message-start":
      setUi((prev) => ({
        ...prev,
        streamingText: "",
      }));
      break;

    case "text-delta":
      setUi((prev) => ({
        ...prev,
        streamingText: prev.streamingText + event.text,
      }));
      break;

    case "tool-call-start":
      setUi((prev) => ({
        ...prev,
        toolCalls: [
          ...prev.toolCalls,
          {
            id: event.toolUseId,
            name: event.name,
            input: event.input,
          },
        ],
      }));
      break;

    case "tool-call-result":
      setUi((prev) => ({
        ...prev,
        toolCalls: prev.toolCalls.map((tc) =>
          tc.id === event.toolUseId
            ? { ...tc, result: { content: event.result.content, isError: event.result.isError } }
            : tc,
        ),
      }));
      break;

    case "message-end":
      // 流式文本已完成，将在 setMessages 中更新
      setUi((prev) => ({
        ...prev,
        streamingText: "",
      }));
      break;

    case "usage":
      setUi((prev) => ({
        ...prev,
        inputTokens: prev.inputTokens + event.inputTokens,
        outputTokens: prev.outputTokens + event.outputTokens,
        tokenCount: prev.tokenCount + event.inputTokens + event.outputTokens,
      }));
      break;

    case "compaction-start":
      setUi((prev) => ({
        ...prev,
        status: "compacting",
      }));
      break;

    case "compaction-end":
      setUi((prev) => ({
        ...prev,
        status: "running",
        tokenCount: ctx.session.tokenCount,
      }));
      break;

    case "error":
      setUi((prev) => ({
        ...prev,
        status: "error",
      }));
      break;

    case "turn-end":
    case "session-end":
      // 这些事件不直接更新 UI（由外层循环处理状态）
      break;
  }
}
