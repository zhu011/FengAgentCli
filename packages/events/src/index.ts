/**
 * @fengagent/events — 事件溯源（Phase 0 定稿类型 + Phase 1 写路径/重放/自愈）
 *
 * 提供：
 * 1. 事件名常量数组（SESSION_EVENT_TYPES）— 核心事件集合
 * 2. 事件类型（SessionEvent 判别联合）— 含 #5 的 hash/prevHash 信封
 * 3. 运行时注册表（SessionEventRegistry + createEventRegistry）—
 *    #1 的「校验走运行时注册表」契约，cordis 复用 service 注入：ctx.eventLog.register()
 * 4. 事件日志存储（EventStore）— 每会话单文件 append-only，重放 + 尾部半行自愈
 * 5. 哈希链工具（#5）— canonicalJson / sha256 / computeEventHash
 *
 * 编译期扩展（declare module 模式，仅管类型、两者解耦）：
 * 插件包可在自己的 .d.ts / .ts 中增补负载类型：
 * ```ts
 * declare module "@fengagent/events" {
 *   interface SessionEventPayloads {
 *     "my/custom": { foo: string };
 *   }
 * }
 * ```
 * 运行时则用 registry.registerEventType("my/custom", validator) 注册校验器。
 */

export * from "./types.ts";
export * from "./registry.ts";
export * from "./hash.ts";
export * from "./event-store.ts";
export * from "./projection.ts";
export * from "./dual-write.ts";
export * from "./reconcile.ts";
