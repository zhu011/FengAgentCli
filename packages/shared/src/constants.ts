/**
 * @fengagent/shared — 共享常量
 *
 * 全局默认值，被 config.ts 的 ConfigSchema 引用。
 */

/** 默认主模型 ID */
export const DEFAULT_MODEL = "claude-sonnet-4-20250514" as const;

/** 默认小模型（压缩、摘要用） */
export const DEFAULT_SMALL_MODEL = "claude-haiku-3" as const;

/** 默认 Provider */
export const DEFAULT_PROVIDER = "anthropic" as const;

/** 默认最大输出 Token 数 */
export const MAX_TOKENS = 8192 as const;

/** 默认生成温度 */
export const DEFAULT_TEMPERATURE = 1.0 as const;

/** 默认上下文窗口大小（Token） */
export const CONTEXT_WINDOW = 200_000 as const;

/** 压缩触发比例（占窗口的百分比） */
export const COMPACT_THRESHOLD = 0.85 as const;

/** 压缩时保留的近期 Token 数 */
export const COMPACT_KEEP_TOKENS = 8000 as const;

/** 压缩缓冲区大小 */
export const COMPACT_BUFFER = 20_000 as const;

/** 工具输出最大字符数 */
export const TOOL_OUTPUT_MAX_CHARS = 2000 as const;

/** 默认服务端口 */
export const DEFAULT_SERVER_PORT = 3000 as const;

/** 默认服务绑定地址 */
export const DEFAULT_SERVER_HOST = "127.0.0.1" as const;

/** 默认 CORS 允许来源 */
export const DEFAULT_CORS_ORIGIN = "*" as const;

/** Bash 命令超时（毫秒） */
export const BASH_TIMEOUT = 120_000 as const;

/** 工具最大并行数 */
export const MAX_TOOL_CONCURRENCY = 10 as const;

/** 单次对话最大轮次 */
export const MAX_TURNS = 50 as const;

/** 默认日志级别 */
export const DEFAULT_LOG_LEVEL = "info" as const;

/** 默认数据存储目录 */
export const DEFAULT_DATA_DIR = "~/.fengagent" as const;

/** 配置文件路径（项目级） */
export const PROJECT_CONFIG_PATH = ".fengagent/config.json" as const;

/** 配置文件路径（全局级） */
export const GLOBAL_CONFIG_PATH = "~/.fengagent/config.json" as const;

/** Token 估算系数（字符数 / 4） */
export const TOKEN_ESTIMATE_RATIO = 4 as const;

/** 小队成员连续失败多少次后进入冷却并触发转派 */
export const SQUAD_MAX_FAILURES = 3 as const;

/** 单个任务最大转派次数 */
export const SQUAD_MAX_REASSIGNMENTS = 3 as const;

/** 成员冷却时长（毫秒） */
export const SQUAD_COOLDOWN_MS = 60_000 as const;

/** 子 Agent 最大嵌套深度（0 = 不允许子 Agent，1 = 允许一层子 Agent） */
export const SUBAGENT_MAX_DEPTH = 2 as const;

/** Agent 定义目录（项目级） */
export const AGENTS_DIR = ".fengagent/agents" as const;

/** Skills 目录（项目级） */
export const SKILLS_DIR = ".fengagent/skills" as const;

/** 插件目录（项目级） */
export const PLUGINS_DIR = ".fengagent/plugins" as const;

/** 工具名正则（字母+数字+下划线+连字符） */
export const TOOL_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
