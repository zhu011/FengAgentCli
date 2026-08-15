/**
 * @fengagent/agent — Agent 类
 *
 * 状态管理、事件发射、会话生命周期。
 * 持有 AgentLoop，对外提供 prompt() 入口。
 * 参考 ARCHITECTURE.md 第 2.3 节（Agent 模块内部依赖）。
 */

import type {
  Config,
  Session,
  AgentEvent,
} from "@fengagent/core";
import { createSession, createUserMessage, createSystemMessage } from "@fengagent/core";
import { AgentLoop } from "./loop.ts";
import type { AgentLoopOptions } from "./loop.ts";
import type { SessionStore } from "./session.ts";
import type { ToolContext } from "@fengagent/core/tool";
import type { ToolRegistry } from "@fengagent/tools";
import type { ContextManager } from "@fengagent/context";
import { createLogger, writeSessionLog } from "@fengagent/shared";

const log = createLogger("agent");

/** Agent 构造选项 */
export interface AgentOptions extends AgentLoopOptions {
  /** 会话存储（可选，不传则不持久化） */
  sessionStore?: SessionStore;
}

/** 权限请求回调类型（从 ToolContext 提取） */
export type RequestPermission = ToolContext["requestPermission"];

/**
 * Agent — Agent 运行时入口。
 *
 * 职责：
 * - 管理 AgentLoop 生命周期
 * - 创建/恢复会话
 * - 持久化会话和消息
 * - 对外暴露 prompt() 作为主要交互入口
 *
 * 用法：
 * ```typescript
 * const agent = new Agent({
 *   llmClient,
 *   toolRegistry,
 *   toolExecutor,
 *   contextManager,
 *   config,
 *   workdir: process.cwd(),
 * });
 * for await (const event of agent.prompt("Hello")) {
 *   // 处理事件
 * }
 * ```
 */
export class Agent {
  private loop: AgentLoop;
  private sessionStore?: SessionStore;
  private config: Config;
  private workdir: string;
  private contextManager: ContextManager;
  private toolRegistry: ToolRegistry;

  constructor(options: AgentOptions) {
    this.loop = new AgentLoop(options);
    this.sessionStore = options.sessionStore;
    this.config = options.config;
    this.workdir = options.workdir;
    this.contextManager = options.contextManager;
    this.toolRegistry = options.toolRegistry;
  }

  /**
   * 发送用户消息并运行 Agent Loop。
   *
   * @param text - 用户输入文本
   * @param session - 可选的已有会话（不传则创建新会话）
   * @param options - 可选运行参数（如权限回调，用于 WebUI 交互式审批）
   * @returns AgentEvent 异步生成器
   */
  async *prompt(
    text: string,
    session?: Session,
    options?: {
      requestPermission?: RequestPermission;
    },
  ): AsyncGenerator<AgentEvent> {
    // 创建或使用已有会话
    const sess = session ?? createSession(this.config.model);
    sess.status = "running";

    log.info("prompt", `start text preview=${text.slice(0, 50)}, sessionId=${sess.id}`);

    // 添加用户消息
    const userMsg = createUserMessage(text);
    sess.messages.push(userMsg);
    sess.updatedAt = Date.now();

    // 会话 JSONL 日志：记录用户消息
    writeSessionLog({
      timestamp: new Date().toISOString(),
      sessionId: sess.id,
      messageId: userMsg.id,
      role: "user",
      content: userMsg.content,
      model: sess.model,
      hasToolCalls: false,
    });

    // 持久化会话和用户消息
    if (this.sessionStore) {
      this.sessionStore.saveSession(sess);
      this.sessionStore.saveMessage(sess.id, userMsg);
    }

    // 发出 session-start 事件
    yield { type: "session-start", session: sess };

    // 运行 Agent Loop
    for await (const event of this.loop.run(sess, options)) {
      // 会话 JSONL 日志：message-end 时记录助手消息
      if (event.type === "message-end") {
        const assistantMsg = sess.messages.find((m) => m.id === event.messageId);
        if (assistantMsg) {
          const toolCalls = assistantMsg.content
            .filter((b) => b.type === "tool-use")
            .map((b): { name: string; input: unknown } => {
              if (b.type === "tool-use") return { name: b.name, input: b.input };
              return { name: "", input: null };
            });
          writeSessionLog({
            timestamp: new Date().toISOString(),
            sessionId: sess.id,
            messageId: assistantMsg.id,
            role: "assistant",
            content: assistantMsg.content.map((b) => {
              if (b.type === "text") return { type: "text", text: b.text.slice(0, 500) };
              if (b.type === "tool-use") return { type: "tool-use", name: b.name };
              if (b.type === "tool-result") return { type: "tool-result", toolUseId: b.toolUseId };
              return { type: b.type };
            }),
            model: sess.model,
            hasToolCalls: toolCalls.length > 0,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            tokenCount: sess.tokenCount,
          });
        }
      }
      yield event;
    }

    // 持久化最终状态
    sess.status = "idle";
    sess.updatedAt = Date.now();
    if (this.sessionStore) {
      this.sessionStore.saveSession(sess);
      // 保存所有新消息（已保存的会被 INSERT OR REPLACE）
      this.sessionStore.saveMessages(sess.id, sess.messages);
    }

    yield { type: "session-end" };

    log.info("prompt", `completed sessionId=${sess.id}`);
  }

  /**
   * 恢复已有会话并发送新消息。
   *
   * @param sessionId - 已有会话 ID
   * @param text - 新用户消息
   * @param options - 可选运行参数（如权限回调）
   * @returns AgentEvent 异步生成器
   */
  async *resume(
    sessionId: string,
    text: string,
    options?: {
      requestPermission?: RequestPermission;
    },
  ): AsyncGenerator<AgentEvent> {
    if (!this.sessionStore) {
      throw new Error("Cannot resume session without a session store");
    }
    const session = this.sessionStore.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    yield* this.prompt(text, session, options);
  }

  /** 创建新会话（不发送消息） */
  createSession(title?: string): Session {
    return createSession(this.config.model, title);
  }

  /** 加载已有会话 */
  loadSession(sessionId: string): Session | null {
    if (!this.sessionStore) return null;
    return this.sessionStore.loadSession(sessionId);
  }

  /** 列出所有会话 */
  listSessions() {
    if (!this.sessionStore) return [];
    return this.sessionStore.listSessions();
  }

  /** 获取工作目录 */
  getWorkdir(): string {
    return this.workdir;
  }

  /** 获取配置 */
  getConfig(): Config {
    return this.config;
  }

  /**
   * 手动压缩当前会话上下文。
   *
   * 调用 ContextManager 的压缩能力，将旧消息摘要化。
   *
   * @param session - 当前会话
   * @returns 压缩结果（摘要 + 保留的近期消息 + 前后 token 数）
   */
  async compactSession(session: Session): Promise<{
    summary: string;
    recentCount: number;
    beforeTokens: number;
    afterTokens: number;
  }> {
    const beforeTokens = this.contextManager.estimateTokens(session.messages);
    const context = await this.contextManager.assemble(session);

    if (!this.contextManager.shouldCompact(context)) {
      // 即使未超阈值也强制压缩
      const compacted = await this.contextManager.compact(session.messages, {
        keepTokens: this.config.compactKeepTokens,
        smallModel: this.config.smallModel,
      });

      session.messages = compacted.summary
        ? [createSystemMessage(compacted.summary), ...compacted.recent]
        : compacted.recent;
      session.tokenCount = this.contextManager.estimateTokens(session.messages);

      // 持久化
      if (this.sessionStore) {
        this.sessionStore.saveSession(session);
        this.sessionStore.saveMessages(session.id, session.messages);
      }

      return {
        summary: compacted.summary,
        recentCount: compacted.recent.length,
        beforeTokens,
        afterTokens: session.tokenCount,
      };
    }

    // 超阈值时正常压缩
    const compacted = await this.contextManager.compact(session.messages, {
      keepTokens: this.config.compactKeepTokens,
      smallModel: this.config.smallModel,
    });

    session.messages = compacted.summary
      ? [createSystemMessage(compacted.summary), ...compacted.recent]
      : compacted.recent;
    session.tokenCount = this.contextManager.estimateTokens(session.messages);

    if (this.sessionStore) {
      this.sessionStore.saveSession(session);
      this.sessionStore.saveMessages(session.id, session.messages);
    }

    return {
      summary: compacted.summary,
      recentCount: compacted.recent.length,
      beforeTokens,
      afterTokens: session.tokenCount,
    };
  }

  /** 获取所有已注册的工具名列表 */
  getToolNames(): string[] {
    return this.toolRegistry.list().map((t) => t.name);
  }

  /** 获取 ContextManager（供外部调用压缩/估算等） */
  getContextManager(): ContextManager {
    return this.contextManager;
  }
}
