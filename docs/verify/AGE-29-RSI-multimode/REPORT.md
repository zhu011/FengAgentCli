# AGE-29 RSI 首期 + 运行态接线：多端真机验证报告（修订版 v2）

> 验证日期：2026-10-19 · 验证人：KG开发 · 分支：main @ `fd49e6a`（origin 一致）
> 修订说明：v1 复核发现「多端覆盖 + 完整截图」不达标（CLI 用 print 非 TUI、WebUI 乱码 + 未到完成态、PIL 渲染未标注）。v2 逐项修订，变更记录见第八节。

## 一、环境

| 项 | 值 |
|---|---|
| 分支 / commit | `main` @ `fd49e6a` |
| 数据根（隔离） | `FENG_DATA_DIR=.verify-rsi/data` |
| 测试集 | `.verify-rsi/data/testsets/rsi-verify.json`（2 用例） |
| LLM | deepseek-v4-pro（真实模型调用） |
| 验证端 | **CLI print 模式**（TUI 降级，见第八节 1）· **WebUI**（serve :3200 + headless Chromium CDP 截图） |

## 二、TUI 尝试与降级说明（如实）

**已尝试真实 TUI**，本沙箱环境不可行：
- `winpty -Xallow-non-tty bun run packages/cli/src/entry.ts` → `Assertion failed: ASSERT_CONDITION("wp != nullptr && cols > 0 && rows > 0")`（winpty 崩溃，无法分配控制台）；
- `tty` → `not a tty`；`TERM=dumb`（无终端仿真器）；
- **结论**：本沙箱无可用 PTY，TUI 的 Ink 交互界面无法在无 TTY 环境下真实运行。

**降级方案**：CLI 验证用 print 模式（`bun run packages/cli/src/entry.ts --print`）——它走**同一 `create-agent.ts` 装配路径**（含 RSI 注入通道 + `onReflectionInjected` 记账），与 TUI 的区别仅在交互渲染层。TUI 的渲染正确性已由 committed 测试 `packages/cli/src/__tests__/tui-render.test.tsx`（16/16 全绿）覆盖。

## 三、验证步骤与命令（可复跑）

```bash
# 0. 准备（在 main worktree 根目录）
mkdir -p .verify-rsi/data/testsets
cp docs/verify/AGE-29-RSI-multimode/rsi-verify-testset.json .verify-rsi/data/testsets/rsi-verify.json
export FENG_DATA_DIR="$(pwd)/.verify-rsi/data"

# 1. 产卡跳
bun run eval --judge

# 2. SQLite 取证（用已提交的脚本）
bun docs/verify/AGE-29-RSI-multimode/query-db.ts

# 3. CLI 注入（print 模式，TUI 降级说明见上）
bun run packages/cli/src/entry.ts --print "请原样回复这个暗号：CLI注入验证-B2-4e8a"
bun docs/verify/AGE-29-RSI-multimode/query-db.ts

# 4. WebUI 注入
FENG_SERVER_PORT=3200 bun run serve &
#    浏览器打开 http://127.0.0.1:3200（或用 API）
curl -s -X POST http://127.0.0.1:3200/api/sessions -H "Content-Type: application/json" -d '{}'
#    取 sessionId 后 POST /:id/messages 发消息，等 run-end 再截图
bun docs/verify/AGE-29-RSI-multimode/query-db.ts
```

## 四、截图索引

| 文件 | 类型 | 内容 |
|---|---|---|
| `00-cli-judge-run.png` | **渲染示意**（原始 stdout 见 `01`） | CLI：`--judge` 产卡跳终端输出（PIL 渲染） |
| `01-db-after-judge.txt` | 原始终端输出 | SQLite：产卡后库状态 |
| `02-cli-print-output.png` | **渲染示意**（原始 stdout 见同目录 `.txt`） | CLI：print 模式对话输出 |
| `02-cli-print-output.txt` | 原始终端输出 | 同上的原始 stdout |
| `03-db-after-cli.png` | **渲染示意**（原始见 `.txt`） | SQLite：CLI 轮后 |
| `03-db-after-cli.txt` | 原始终端输出 | 同上（含完整 `effect_json`：`{"injectedCount":1,"lastInjectedAt":...}`） |
| `04-webui-round1-sse.txt` | 原始 SSE 流 | WebUI：第一轮对话事件流 |
| `05-db-after-webui.txt` | 原始终端输出 | SQLite：WebUI SSE 轮后（injectedCount=2） |
| `06-webui-home.png` | **真实浏览器截图**（CDP） | WebUI：首页（会话列表 + 导航） |
| `07-webui-session.png` | **真实浏览器截图**（CDP） | WebUI：会话页（完整对话，完成态，UTF-8 正确） |
| `08-webui-page-text-r2.txt` | DOM 文本快照 | 同上时刻的页面文本（UTF-8 无乱码，消息 `WebUI完成态-D5-3a7e` 可见） |
| `09-db-after-webui.png` | **渲染示意**（原始见 `.txt`） | SQLite：WebUI 界面轮后 |
| `09-db-after-webui-shots.txt` | 原始终端输出 | 同上 |
| `11-webui-round2-sse.txt` | 原始 SSE 流 | WebUI：第二轮（API UTF-8 消息，完成态 run-end） |
| `12-db-after-webui-r2.txt` | 原始终端输出 | SQLite：第二轮后（injectedCount=3） |

**截图类型说明**：
- **真实浏览器截图**（`06`、`07`）：headless Chromium + CDP `Page.captureScreenshot`，直接截取渲染后的页面像素——非文本拼图；
- **渲染示意**（`00`、`02`、`03`、`09`）：因本沙箱无终端截图工具（无 GUI 终端），CLI 终端输出与 SQLite 查询结果用 PIL 渲染为终端风格 PNG；**对应的原始 stdout / 查询输出全部保留在同目录 `.txt` 文件中**，渲染仅为视觉辅助，证据以 `.txt` 为准。

## 五、现象（逐跳）

### 产卡跳（`--judge`）
- 测试集 2 用例**真跑**：case-greet 通过；case-fail 失败（bash 需审批但评测 Agent 无回调 → 不可恢复终止——已知设计）。
- **产卡 1 张、入库 1 张**：`reflections.db` 创建，`status=proposed`、`trigger=judge_failed`，事件链 `reflect/card-created`。

### CLI 注入（print 模式，TUI 降级）
- 对话正常完成（暗号 `CLI注入验证-B2-4e8a` 正确回复）。
- **卡片 `status=injected`、`effect_json.injectedCount=1`**（完整 JSON 见 `03-db-after-cli.txt`）。
- **`reflect/injected` 事件**（seq=3），`payload.sessionId` = CLI 会话 `8ecb8db9…`。

### WebUI 注入（真实浏览器 + 完成态）
- **第二轮（修订）**：API 发送 UTF-8 消息 `请原样回复这个暗号：WebUI完成态-D5-3a7e` → **等到 `run-end`**（完成态，非 Streaming/Running）→ 浏览器截图。
- **页面 UTF-8 正确**：DOM 快照确认 `WebUI完成态-D5-3a7e` 完整可见（`08-webui-page-text-r2.txt`），无乱码。
- **`injectedCount=3`**（第三会话注入），新增 `reflect/injected`（seq=7）`sessionId` = `8fbaac0b…`。
- 事件链完整：`card-created → card-updated → reflect/injected` ×3（三个不同会话）。

### 注入计数语义
- `injectedCount` **按会话**递增（CLI +1、WebUI SSE +1、WebUI 界面 +1 = 3），**不按装配步数放大**。

## 六、结论

| 验证项 | 判定 |
|---|---|
| 产卡跳（默认路径 `--judge` → `reflections.db` 非空） | ✅ 通过 |
| CLI 注入（print 模式，TUI 降级已标注） | ✅ 通过 |
| WebUI 注入（真实浏览器截图 + UTF-8 + 完成态） | ✅ 通过 |
| `injectedCount` 按会话 +1 不放大 | ✅ 通过 |
| 注入不破坏对话（CLI/WebUI 均正常回复） | ✅ 通过 |
| CLI TUI 真实运行 | ⚠️ 降级为 print（沙箱无 PTY，已尝试并如实记录） |

**RSI 首期 L1 闭环在 CLI（print 模式）与 WebUI（真实浏览器）两条对话路径的默认运行上均真实开通。**

## 七、边界与已知观察

1. **TUI 降级**：本沙箱无 PTY（winpty 崩溃 + 非 tty），TUI 无法真实运行；已尝试并如实记录。print 模式走同一装配路径（`create-agent.ts`），TUI 渲染正确性由 committed 测试 `tui-render.test.tsx` 16/16 覆盖。后续在有 GUI 终端的环境可补拍真 TUI 截图。
2. **评测 Agent 无工具审批回调**：`--judge` 跑需 bash 的用例以「requires approval 无 callback」失败——已知设计，不产假卡。
3. **ACP/Multica 侧未单独跑**：需 daemon 环境；`onReflectionInjected` 接线已随 `fd49e6a` 合入。
4. **资产单侧原因**：验证在 main worktree 执行（main 是运行分支），refactor 侧代码与 main 同构（`9d71f3f` + `fd49e6a`），无需重复执行；资产在 main 的 `docs/verify/AGE-29-RSI-multimode/`，refactor 侧可通过 `git cherry-pick` 同步（纯新增文件，无冲突）。
5. **数据隔离**：全部验证在 `.verify-rsi/data` 独立数据根下，未触碰生产数据。

## 八、v1 → v2 修订记录

| # | v1 问题（claude大哥 复核） | v2 修订 |
|---|---|---|
| 1 | CLI 用 print 非 TUI | 已尝试真 TUI（winpty 崩溃 + 非 tty），降级 print 并在报告第二节如实标注；TUI 渲染由 committed 测试覆盖 |
| 2 | WebUI 乱码 + 未到完成态 | 改用 API 发 UTF-8 消息（服务端编码正确）→ 等 `run-end` → 重拍截图；DOM 快照确认无乱码、消息可见 |
| 3 | `00/02` 是 PIL 渲染非真截图 | 保留 PIL 渲染但在索引中**明确标注「渲染示意」**，对应的原始 stdout `.txt` 全部保留 |
| 4 | 截图计数错误（实际 6 PNG + 9 TXT） | 已修正（v1 报告虚报「9 张」） |
| 5 | `03` 右侧 `effect_json` 被裁 | PNG 渲染窗口加宽；完整 JSON 在 `.txt` 原始输出中 |
| 6 | 复跑命令引用 `.verify-rsi/query-db.ts`（未提交） | 改引 `docs/verify/AGE-29-RSI-multimode/query-db.ts`（已提交） |
| 7 | 资产单侧 | 在第七节第 4 条说明单侧原因（main 是运行分支） |

## 九、复跑

见第三节（命令已改引已提交路径）。
