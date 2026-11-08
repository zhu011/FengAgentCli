import { defineConfig } from "vitepress";

/**
 * FengAgentCli 文档站配置
 *
 * 内容 = docs/*.md 单一事实源（改 md 即改站）；构建产物在
 * docs/.vitepress/dist，由 .github/workflows/deploy-docs.yml 推 gh-pages。
 * 风格：内页克制排版参考 claude docs，首页 hero + 特性卡片参考 deepseek platform；
 * 品牌色沿用项目雾蓝 + 深空暗色（见 theme/custom.css）。
 */
export default defineConfig({
  lang: "zh-CN",
  // GitHub Pages 项目站：zhu011.github.io/FengAgentCli/ —— 资产必须带此前缀
  base: "/FengAgentCli/",
  title: "FengAgentCli",
  description: "开源本地 AI Agent 对话平台 — 对话 / 工具调用 / 多 Agent 团队协作 / 插件市场",
  head: [["meta", { name: "theme-color", content: "#0a0a0f" }]],

  // 内部材料不进站：验收报告、产品 PRD、旧手写站残留
  srcExclude: ["**/verify/**", "**/PRD.md"],

  cleanUrls: true,

  themeConfig: {
    // 站内搜索（本地索引，无需外部服务）
    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
          modal: {
            noResultsText: "没有找到相关结果",
            resetButtonTitle: "清除查询",
            footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
          },
        },
      },
    },

    outline: { level: [2, 3], label: "本页目录" },
    docFooter: { prev: "上一篇", next: "下一篇" },
    lastUpdated: { text: "最后更新" },
    returnToTopLabel: "回到顶部",
    sidebarMenuLabel: "菜单",
    darkModeSwitchLabel: "主题",
    lightModeSwitchTitle: "切换到亮色",
    darkModeSwitchTitle: "切换到暗色",

    nav: [
      { text: "首页", link: "/" },
      { text: "快速上手", link: "/QUICKSTART" },
      {
        text: "文档",
        items: [
          { text: "操作手册（保姆级）", link: "/GUIDE-CORDIS" },
          { text: "插件与市场", link: "/PLUGINS" },
          { text: "接入外部 Agent", link: "/AGENTS-DISPATCH" },
          { text: "群聊", link: "/GROUPS" },
          { text: "Settings", link: "/SETTINGS" },
        ],
      },
      { text: "GitHub", link: "https://github.com/zhu011/FengAgentCli" },
    ],

    sidebar: [
      {
        text: "快速上手",
        items: [{ text: "QUICKSTART · 从零到全部功能", link: "/QUICKSTART" }],
      },
      {
        text: "用户手册",
        collapsed: false,
        items: [
          { text: "操作手册（保姆级）", link: "/GUIDE-CORDIS" },
          { text: "MCP 与工具授权", link: "/MCP-PERMISSIONS" },
          { text: "接入外部 Agent（团队派单）", link: "/AGENTS-DISPATCH" },
          { text: "多 Agent 群聊", link: "/GROUPS" },
          { text: "插件与市场", link: "/PLUGINS" },
          { text: "Settings（模型热切换）", link: "/SETTINGS" },
        ],
      },
      {
        text: "开发者",
        collapsed: true,
        items: [
          { text: "架构设计（Cordis）", link: "/ARCHITECTURE-CORDIS" },
          { text: "扩展指南", link: "/EXTENDING" },
          { text: "开发指南", link: "/DEVELOPMENT" },
          { text: "dsh 互通契约", link: "/DSH-CONTRACT-MAP" },
        ],
      },
      {
        text: "参考",
        collapsed: true,
        items: [
          { text: "配置参考", link: "/CONFIGURATION" },
          { text: "模块 API", link: "/MODULES" },
          { text: "评测与自优化", link: "/EVALUATION" },
          { text: "RSI 使用指南", link: "/RSI-USAGE" },
          { text: "实验沙箱", link: "/SANDBOX" },
        ],
      },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/zhu011/FengAgentCli" }],
  },
});
