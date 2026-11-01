/**
 * dsh 风格的服务面消费者（P2 夹具）
 *
 * 模拟一个真实 dsh 插件的最小形状：命名导出 name/inject/apply，装配时通过
 * `ctx.sessions` / `ctx.agents` / `ctx.agentDefaultModel` 工作。用于验证
 * `dsh-services` 装配后 inject 能解析、服务面真的可用。
 */

export const name = "dsh-session-consumer";
export const inject = ["sessions", "agents", "agentDefaultModel"];

export function apply(ctx, config = {}) {
  void config;
  if (typeof ctx.sessions?.list !== "function") {
    throw new Error("dsh-session-consumer: ctx.sessions 不可用");
  }
  if (typeof ctx.agents?.withInitiator !== "function") {
    throw new Error("dsh-session-consumer: ctx.agents 不可用");
  }
  if (typeof ctx.agentDefaultModel?.currentSelection !== "function") {
    throw new Error("dsh-session-consumer: ctx.agentDefaultModel 不可用");
  }

  const session = ctx.sessions.create("consumer-session");
  ctx.agents.withInitiator({ id: session.id, session }, () => {
    if (!ctx.agents.currentInitiator()) {
      throw new Error("dsh-session-consumer: initiator 边界没有生效");
    }
  });
  if (!ctx.agentDefaultModel.currentSelection().provider) {
    throw new Error("dsh-session-consumer: 默认模型不可读");
  }

  globalThis.__dshConsumerProbe = {
    sessionId: session.id,
    sessions: ctx.sessions.list().map((item) => item.id),
  };
}

export default { name, inject, apply };
