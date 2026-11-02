// S1 端到端示例：WebUI 插件 client.mjs
// react 经宿主共享单例（window.__FENG_REACT__），不自带 react。
const React = globalThis.__FENG_REACT__;

export function setup(ctx) {
  ctx.registerSlot("nav-extension", function ExampleNavPanel() {
    const [count, setCount] = React.useState(0);
    return React.createElement(
      "div",
      { style: { display: "flex", gap: 10, alignItems: "center", padding: "6px 16px", fontSize: 12 } },
      React.createElement("span", { "data-testid": "webui-plugin-hello" }, `插件示例：${ctx.plugin.name} v${ctx.plugin.version}`),
      React.createElement(
        "button",
        {
          onClick: () => {
            setCount((c) => c + 1);
            ctx.toast(`示例插件第 ${count + 1} 次点击`, "info");
          },
        },
        `toast ×${count}`,
      ),
    );
  });
}
