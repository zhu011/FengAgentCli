/**
 * @fengagent/dsh-compat — `ctx.agents` 契约映射（P2）
 *
 * dsh 的 `AgentRegistry` 有两半：
 * 1. **live registry**（get/list/roots/register/enter/announce/isOwnedBy）——本文件
 *    在进程内维护一张与 `ctx.sessions` 视图同源的表，语义可直通；
 * 2. **creation factory**（create/resume）——dsh 里由 loop 实现
 *    （`dsh-agent-loop` 构造时 `setFactory`）并提供给 registry。FengAgentCli 的
 *    loop 是 `ctx.loop`（按会话跑回合），没有「创建即启动 agent」的工厂面，
 *    所以 **未注册 factory 时 create/resume 明确抛不支持**，而不是自己造一个
 *    「假 agent」。factory 的桥接（loop → AgentFactory）属于 P4。
 *
 * Initiator（`withInitiator` / `currentInitiator`）用 `AsyncLocalStorage` 实现
 * 进程内因果归属：与 dsh 一样只做归因，不做鉴权/liveness 证明。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  DshContractError,
  DshContractUnsupportedError,
  type DshAgentFactory,
  type DshAgentHandle,
  type DshAgentLike,
  type DshAgentsLike,
  type DshContextLike,
  type DshCreateAgentOptions,
  type DshResumeAgentOptions,
} from "./contracts.ts";
import type { CompatSession, SessionsCompat } from "./sessions.ts";

/** dsh `Agent` 的映射：身份 = 会话 id（dsh 亦然），session 指向投影 */
export class CompatAgent implements DshAgentLike {
  constructor(readonly session: CompatSession) {}

  get id(): string {
    return this.session.id;
  }
}

/** registry 条目：owner 是运行时创建者（不是会话血缘） */
interface AgentEntry {
  readonly agent: CompatAgent;
  readonly owner: CompatAgent | undefined;
  announced: boolean;
}

/** `ctx.agents` 的映射实现 */
export class AgentsCompat implements DshAgentsLike {
  private readonly entries = new Map<string, AgentEntry>();
  private factory: DshAgentFactory | undefined;
  private readonly initiator = new AsyncLocalStorage<CompatAgent>();

  constructor(
    private readonly ctx: DshContextLike,
    private readonly sessions: SessionsCompat,
  ) {}

  get(id: string): CompatAgent | undefined {
    return this.entries.get(id)?.agent;
  }

  list(): CompatAgent[] {
    return [...this.entries.values()].map((entry) => entry.agent);
  }

  roots(): CompatAgent[] {
    return [...this.entries.values()]
      .filter((entry) => entry.owner === undefined)
      .map((entry) => entry.agent);
  }

  register(agent: DshAgentLike): () => void {
    this.assertAgent(agent, "agents.register");
    if (this.entries.has(agent.id)) {
      throw new DshContractError("agents.register", `agent "${agent.id}" is already registered`);
    }
    this.entries.set(agent.id, {
      agent: agent as CompatAgent,
      owner: undefined,
      announced: true,
    });
    return () => {
      this.entries.delete(agent.id);
    };
  }

  enter(agent: DshAgentLike, owner: DshAgentLike | undefined): () => void {
    this.assertAgent(agent, "agents.enter");
    if (this.entries.has(agent.id)) {
      throw new DshContractError("agents.enter", `agent "${agent.id}" is already registered`);
    }
    this.entries.set(agent.id, {
      agent: agent as CompatAgent,
      owner: owner as CompatAgent | undefined,
      announced: false,
    });
    return () => {
      this.entries.delete(agent.id);
    };
  }

  announce(agent: DshAgentLike): void {
    const entry = this.entries.get(agent.id);
    if (!entry || entry.agent !== (agent as CompatAgent)) {
      throw new DshContractError("agents.announce", `agent "${agent.id}" is not the live entry`);
    }
    if (entry.announced) {
      throw new DshContractError("agents.announce", `agent "${agent.id}" was already announced`);
    }
    entry.announced = true;
  }

  isOwnedBy(id: string, owner: DshAgentLike): boolean {
    return this.entries.get(id)?.owner === (owner as CompatAgent);
  }

  setFactory(factory: DshAgentFactory): () => void {
    if (this.factory !== undefined) {
      throw new DshContractError("agents.setFactory", "a factory is already registered");
    }
    if (typeof factory?.createAgent !== "function" || typeof factory?.resume !== "function") {
      throw new DshContractError(
        "agents.setFactory",
        "factory must implement createAgent() and resume()",
      );
    }
    this.factory = factory;
    return () => {
      if (this.factory === factory) this.factory = undefined;
    };
  }

  async create(options: DshCreateAgentOptions): Promise<DshAgentHandle> {
    const factory = this.requireFactory("agents.create");
    return factory.createAgent(this.ctx, options);
  }

  async resume(options: DshResumeAgentOptions): Promise<DshAgentHandle> {
    if (!this.sessions.get(options.resumeSessionId)) {
      throw new DshContractError(
        "agents.resume",
        `session "${options.resumeSessionId}" does not exist`,
      );
    }
    const factory = this.requireFactory("agents.resume");
    return factory.resume(this.ctx, options);
  }

  withInitiator<T>(agent: DshAgentLike, operation: () => T): T {
    this.assertAgent(agent, "agents.withInitiator");
    return this.initiator.run(agent as CompatAgent, operation);
  }

  withoutInitiator<T>(operation: () => T): T {
    return this.initiator.exit(operation);
  }

  currentInitiator(): CompatAgent | undefined {
    return this.initiator.getStore();
  }

  requireInitiator(): CompatAgent {
    const agent = this.initiator.getStore();
    if (!agent) {
      throw new DshContractError(
        "agents.requireInitiator",
        "no initiator boundary is active; wrap the call in ctx.agents.withInitiator(agent, ...)",
      );
    }
    return agent;
  }

  private requireFactory(contract: "agents.create" | "agents.resume"): DshAgentFactory {
    if (!this.factory) {
      throw new DshContractUnsupportedError(
        contract,
        "no AgentFactory is registered for this runtime; FengAgentCli's ctx.loop runs turns on an existing session, " +
          "and the loop→AgentFactory bridge is scheduled for P4",
      );
    }
    return this.factory;
  }

  private assertAgent(
    agent: DshAgentLike,
    contract: "agents.register" | "agents.enter" | "agents.withInitiator",
  ): void {
    if (
      agent === null ||
      typeof agent !== "object" ||
      typeof agent.id !== "string" ||
      agent.id.length === 0 ||
      typeof agent.session !== "object" ||
      agent.session === null
    ) {
      throw new DshContractError(contract, "agent must expose a non-empty id and a session");
    }
  }
}

/** 从 `ctx.sessions` 的 live 视图取一个 agent（factory 桥接与测试共用，不伪造会话） */
export function createCompatAgent(
  sessions: SessionsCompat,
  sessionId: string,
): CompatAgent | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  return new CompatAgent(session);
}
