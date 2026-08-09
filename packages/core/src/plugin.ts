/**
 * @fengagent/core — 插件接口定义
 *
 * FengPlugin 接口、PluginContext、插件注册项类型。
 * 参考 ARCHITECTURE.md 第 4.5 节。
 */

import type { ToolDefinition } from "./tool.ts";
import type { PermissionResult } from "./permission.ts";

/** 插件上下文 — 传递给插件 init() 的运行时信息 */
export interface PluginContext {
  /** 工作目录 */
  workdir: string;
  /** 配置对象（只读快照） */
  config: Record<string, unknown>;
  /** 日志函数 */
  log: (message: string) => void;
}

/** 插件注册的工具 */
export interface PluginRegistrations {
  /** 注册的工具定义 */
  tools: ToolDefinition[];
  /** 注册的命令（命令名 → 处理函数） */
  commands: Map<string, (args: string[]) => Promise<string>>;
  /** 注册的 Hook 处理函数 */
  hooks: {
    preToolUse?: (toolName: string, input: unknown) => PermissionResult | void;
    postToolUse?: (toolName: string, input: unknown, result: unknown) => void;
  };
}

/**
 * FengAgent 插件接口。
 *
 * 每个插件实现此接口，从 `.fengagent/plugins/<name>/index.ts` 导出 default class。
 * 生命周期：load → init → register → run → dispose
 */
export interface FengPlugin {
  /** 插件名称 */
  name: string;
  /** 插件版本 */
  version: string;
  /** 初始化（可选） */
  init?(context: PluginContext): Promise<void>;
  /** 注册工具、命令、Hook */
  register(context: PluginContext): Promise<PluginRegistrations>;
  /** 销毁（可选，清理资源） */
  dispose?(): Promise<void>;
}

/** 插件加载结果 */
export interface PluginLoadResult {
  /** 插件名称 */
  name: string;
  /** 插件版本 */
  version: string;
  /** 加载状态 */
  status: "loaded" | "error";
  /** 错误信息（status=error 时） */
  error?: string;
  /** 注册的工具、命令、Hook（status=loaded 时） */
  registrations?: PluginRegistrations;
}
