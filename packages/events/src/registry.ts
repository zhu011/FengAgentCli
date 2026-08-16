/**
 * @fengagent/events — 运行时事件注册表（#1 最小实现）
 *
 * 核心类型预置默认校验器（结构最小校验：信封字段齐全）；
 * 自定义类型经 registerEventType(type, validator) 注册后即可通过校验。
 */

import type {
  SessionEvent,
  SessionEventBase,
  SessionEventRegistry,
  SessionEventValidator,
} from "./types.ts";
import { SESSION_EVENT_TYPES } from "./types.ts";

/** 默认（未注册）校验器 — 结构最小校验：信封字段齐全 */
const DEFAULT_VALIDATOR: SessionEventValidator = (event) =>
  event !== null &&
  typeof event === "object" &&
  typeof (event as SessionEventBase).sessionId === "string" &&
  typeof (event as SessionEventBase).seq === "number" &&
  typeof (event as SessionEventBase).timestamp === "string" &&
  typeof (event as SessionEventBase).hash === "string";

/**
 * 创建最小内存版事件注册表（Phase 1 起由事件存储实现方替换/包装，
 * 事件日志写路径的 isSessionEvent/append 校验即走本注册表）。
 */
export function createEventRegistry(): SessionEventRegistry {
  const validators = new Map<string, SessionEventValidator>();

  function registerEventType(type: string, validator?: SessionEventValidator): void {
    validators.set(type, validator ?? DEFAULT_VALIDATOR);
  }

  function has(type: string): boolean {
    return validators.has(type);
  }

  function validate(event: SessionEvent): boolean {
    const validator = validators.get(event.type);
    if (!validator) return false;
    try {
      return validator(event) !== false;
    } catch {
      return false;
    }
  }

  // 预置核心类型（默认校验器）
  for (const type of SESSION_EVENT_TYPES) {
    registerEventType(type);
  }

  return { registerEventType, has, validate };
}
