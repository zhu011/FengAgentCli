/**
 * @fengagent/web-ui — 插件市场 mock 后端（Settings「市场」tab · C）
 *
 * 后端 MarketCatalogService（`GET /api/plugins/market`）落地前的 fixture 数据源：
 * 页面探测市场 API 失败（或 `?mock=1`）时自动回退，契约与 client.ts 市场方法
 * 一一对齐（plugins / total / limit / offset / categories，条目形状对齐 cordis
 * `MarketPluginEntry`：compat A/B/C + compatReason + installable）。
 *
 * 条目取自 awesome-dsh-plugin format-1 catalog 的真实数据（名称/版本/分类/描述）；
 * compat 档位为演示代表值——真实档位由服务端按 catalog/registry 元数据判定。
 */

import type { MarketCatalogResponse, MarketCategory, MarketEntry, MarketQuery } from "./types.ts";

/** fixture 分类（只列有条目的分类，与服务端「按结果集裁剪」的行为一致） */
export const MARKET_MOCK_CATEGORIES: MarketCategory[] = [
  { id: "tools", title: { zh: "工具与能力", en: "Tools & Capabilities" } },
  { id: "memory", title: { zh: "记忆", en: "Memory" } },
  { id: "vision", title: { zh: "视觉与多模态", en: "Vision & Multimodal" } },
  { id: "market", title: { zh: "插件市场与管理", en: "Plugin Markets & Managers" } },
  { id: "theme", title: { zh: "主题与外观", en: "Themes & Appearance" } },
  { id: "voice", title: { zh: "语音与音频", en: "Voice & Audio" } },
  { id: "ui", title: { zh: "UI 增强", en: "UI Enhancements" } },
];

const REASON_A = "声明 fengagent.webui：装完刷新页面即渲染";
const REASON_B = "dsh host 侧插件：走 dsh-compat 装载，装完需重启宿主";
const REASON_C = "dsh.client 客户端插件：需要 dsh UI 兼容层，本期不渲染（对照组）";

/** fixture 目录（A 档 1 条 + B 档 6 条 + C 档 2 条，覆盖三档与多分类） */
export const MARKET_MOCK_ENTRIES: MarketEntry[] = [
  {
    name: "example-webui-plugin",
    title: "FengAgent 示例 WebUI 插件",
    description: "S1 端到端示例 WebUI 插件：nav-extension slot 渲染 + toast + assets 引用。装上即出现在主导航旁。",
    category: "ui",
    latestVersion: "0.1.0",
    compat: "A",
    compatReason: REASON_A,
    compatSource: "registry",
    installable: true,
    repository: "https://github.com/zhu011/FengAgentCli",
  },
  {
    name: "dsh-better-edit",
    title: "Rianico/dsh-better-edit",
    description: "基于哈希锚定的 read / edit / batch_edit / undo_last_edit 工具：每行分配唯一的 3 字符内容哈希，编辑按哈希而非行号定位；对已提供状态逐行校验，过期范围会被拒绝并回传新锚点。",
    category: "tools",
    latestVersion: "1.2.0",
    compat: "B",
    compatReason: REASON_B,
    compatSource: "catalog",
    installable: true,
    repository: "https://github.com/Rianico/dsh-better-edit",
    homepage: "https://awesome-dsh-plugin.com/p/Rianico/dsh-better-edit/",
  },
  {
    name: "dsh-plugin-writing-guard",
    title: "xmutfyh/dsh-plugin-writing-guard",
    description: "论文写作守卫（中英双语）：去掉 AI 式防御性写作，润色时守住科学证据（数字/引用/主张强度/零结果/scope），并按目标期刊校准写作风格。纯本地正则/统计，零网络零 LLM。",
    category: "tools",
    latestVersion: "2.0.1",
    compat: "B",
    compatReason: REASON_B,
    compatSource: "catalog",
    installable: true,
    repository: "https://github.com/xmutfyh/dsh-plugin-writing-guard",
    homepage: "https://awesome-dsh-plugin.com/p/xmutfyh/dsh-plugin-writing-guard/",
  },
  {
    name: "dsh-tool-todo-plus",
    title: "shuxidemosheng/dsh-tool-todo-plus",
    description: "官方 todo_write 的增强 fork：任务项支持优先级标签、会话内完整清单渲染，并提供可拖动的会话内浮动任务面板（位置记忆 / 双击复位 / 当前动作显示）。",
    category: "tools",
    latestVersion: "0.7.4",
    compat: "B",
    compatReason: REASON_B,
    compatSource: "catalog",
    installable: true,
    repository: "https://github.com/shuxidemosheng/dsh-tool-todo-plus",
    homepage: "https://awesome-dsh-plugin.com/p/shuxidemosheng/dsh-tool-todo-plus/",
  },
  {
    name: "@yolk_vat-y/dsh-project-memory",
    title: "00080000/dsh-project-memory",
    description: "为 DeepSeek Harness 提供持久化的项目级记忆。原生融合 dsh 任务系统，会话内任务清单与读过的文件自动沉淀为跨会话任务记录，任务↔文件自动关联——开发工作流可切换、可续接。",
    category: "memory",
    latestVersion: "0.6.9",
    compat: "B",
    compatReason: REASON_B,
    compatSource: "catalog",
    installable: true,
    repository: "https://github.com/00080000/dsh-project-memory",
    homepage: "https://awesome-dsh-plugin.com/p/00080000/dsh-project-memory/",
  },
  {
    name: "@liustack/modlens",
    title: "liustack/modlens",
    description: "为纯文本模型架起视觉桥梁：粘贴图片，输出结构化 JSON 证据（OCR、版面、语义）。",
    category: "vision",
    latestVersion: "3.27.2",
    compat: "B",
    compatReason: REASON_B,
    compatSource: "catalog",
    installable: true,
    repository: "https://github.com/liustack/modlens",
    homepage: "https://awesome-dsh-plugin.com/p/liustack/modlens/",
  },
  {
    name: "@memef1f1y/dsh-plugin-tts",
    title: "1624318455/dsh-plugin-tts",
    description: "用免费 Edge TTS 或你自己的 RVC 音色朗读 AI 回复：消息朗读与自动朗读、长文自适应分块渐进播放（无缝衔接）、音色包仓库一键安装、便携 RVC 运行时。",
    category: "voice",
    latestVersion: "0.6.7",
    compat: "B",
    compatReason: REASON_B,
    compatSource: "catalog",
    installable: true,
    repository: "https://github.com/1624318455/dsh-plugin-tts",
    homepage: "https://awesome-dsh-plugin.com/p/1624318455/dsh-plugin-tts/",
  },
  {
    name: "dshmarket",
    title: "dsh-market/dsh-market",
    description: "在 DeepSeek Harness 设置页内浏览、搜索并安装社区插件，支持分类筛选、一键更新与停用，以及主题切换与配置备份。（dsh 客户端协议 UI 插件——对照组）",
    category: "market",
    latestVersion: "1.73.9",
    compat: "C",
    compatReason: REASON_C,
    compatSource: "registry",
    installable: false,
    repository: "https://github.com/dsh-market/dsh-market",
    homepage: "https://awesome-dsh-plugin.com/p/dsh-market/dsh-market/",
  },
  {
    name: "dsh-codefall",
    title: "4444Hao/dsh-codefall",
    description: "为 DeepSeek Harness 添加黑客帝国风格的数字雨开屏动画、向两侧展开的矩形光门、可选的窗口恢复重播，以及可调色相的绿色界面主题。",
    category: "theme",
    latestVersion: "0.2.0",
    compat: "C",
    compatReason: REASON_C,
    compatSource: "registry",
    installable: false,
    repository: "https://github.com/4444Hao/dsh-codefall",
    homepage: "https://awesome-dsh-plugin.com/p/4444Hao/dsh-codefall/",
  },
];

/** 按服务端契约做客户端过滤 + 分页（fixture 联调用） */
export function queryMarketMock(query: MarketQuery): MarketCatalogResponse {
  const q = (query.q ?? "").trim().toLowerCase();
  const matched = MARKET_MOCK_ENTRIES.filter((e) => {
    if (query.category && e.category !== query.category) return false;
    if (q) {
      const hay = `${e.name} ${e.title} ${entryDescription(e)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 24;
  return {
    plugins: matched.slice(offset, offset + limit),
    total: matched.length,
    offset,
    limit,
    categories: MARKET_MOCK_CATEGORIES,
  };
}

function entryDescription(e: MarketEntry): string {
  return e.description ?? e.descriptionI18n?.zh ?? e.descriptionI18n?.en ?? "";
}
