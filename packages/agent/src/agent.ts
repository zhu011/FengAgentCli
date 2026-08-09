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
import { createSession, createUserMessage } from "@fengagent/core";
import { AgentLoop } from "./loop.ts";
import type { AgentLoopOptions } from "./loop.ts";
import type { SessionStore } from "./session.ts";
import type { ToolContext } from "@fengagent/core/tool";

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

  constructor(options: AgentOptions) {
    this.loop = new AgentLoop(options);
    this.sessionStore = options.sessionStore;
    this.config = options.config;
    this.workdir = options.workdir;
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

    // 添加用户消息
    const userMsg = createUserMessage(text);
    sess.messages.push(userMsg);
    sess.updatedAt = Date.now();

    // 持久化会话和用户消息
    if (this.sessionStore) {
      this.sessionStore.saveSession(sess);
      this.sessionStore.saveMessage(sess.id, userMsg);
    }

    // 发出 session-start 事件
    yield { type: "session-start", session: sess };

    // 运行 Agent Loop
    for await (const event of this.loop.run(sess, options)) {
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
}
