# AGE-29 RSI 首期 + 运行态接线：多端真机验证报告

> 验证日期：2026-10-19 · 验证人：KG开发 · 分支：main @ `fd49e6a`（origin 一致）
> 约束：只验证 + 产出测试资产，不改功能代码（本轮零功能改动）。

## 一、环境

| 项 | 值 |
|---|---|
| 分支 / commit | `main` @ `fd49e6a`（RSI 首期 `9d71f3f` + 运行态接线适配） |
| 数据根（隔离） | `FENG_DATA_DIR=.verify-rsi/data`（独立于生产数据，测试后可整目录删除） |
| 测试集 | `.verify-rsi/data/testsets/rsi-verify.json`（2 用例：1 简单回显 + 1 需 bash 工具） |
| LLM | deepseek-v4-pro（openai-compatible gateway，真实模型调用） |
| 验证端 | CLI print 模式（`bun run packages/cli/src/entry.ts --print`）· WebUI（`bun run serve` :3200 + 浏览器 CDP） |

## 二、验证步骤与命令（可复跑）

```bash
# 0. 准备（在 main worktree 根目录）
mkdir -p .verify-rsi/data/testsets
#    写入测试集（见 assets/ 同目录参考，2 用例）
export FENG_DATA_DIR="$(pwd)/.verify-rsi/data"

# 1. 产卡跳：测试集真跑 → 产卡入库
bun run eval --judge
#    预期：输出「产卡 N 张、入库 N 张」+ 库路径

# 2. SQLite 取证（产卡后）
bun .verify-rsi/query-db.ts
#    预期：reflections 表 ≥1 行（status=proposed）、reflection_events 有 reflect/card-created

# 3. CLI 注入验证（print 模式）
bun run packages/cli/src/entry.ts --print "请原样回复这个暗号：CLI注入验证-B2-4e8a"
#    预期：正常回复 + 系统提示注入「过往教训」

# 4. SQLite 取证（CLI 轮后）
bun .verify-rsi/query-db.ts
#    预期：卡片 status=injected、effect_json.injectedCount=1、事件链出现 reflect/injected

# 5. WebUI 注入验证
FENG_SERVER_PORT=3200 bun run serve &
curl -s -X POST http://127.0.0.1:3200/api/sessions -H "Content-Type: application/json" -d '{}'
#    → 取 sessionId，POST /:id/messages 发消息（SSE 流取证见 assets/04）
#    或直接在浏览器打开 http://127.0.0.1:3200 用界面对话（截图见 assets/06-08）

# 6. SQLite 终态取证
bun .verify-rsi/query-db.ts
#    预期：injectedCount 按会话 +1（不按装配步数放大）、每会话恰一条 reflect/injected
```

## 三、截图索引

| 文件 | 内容 |
|---|---|
| `assets/00-cli-judge-run.png` | CLI：`bun run eval --judge` 产卡跳终端输出（2 用例真跑 → 产卡 1 张入库） |
| `assets/01-db-after-judge.txt` | SQLite：产卡后库状态（1 卡 proposed + card-created 事件） |
| `assets/02-cli-print-output.png` | CLI：print 模式对话输出（暗号正确回复） |
| `assets/02-cli-print-output.txt` | 同上的原始 stdout |
| `assets/03-db-after-cli.png` | SQLite：CLI 轮后（status=injected、injectedCount=1、reflect/injected 事件） |
| `assets/03-db-after-cli.txt` | 同上的原始查询输出 |
| `assets/04-webui-round1-sse.txt` | WebUI：SSE 原始事件流（第一轮对话，含 tool-call-start / message-end） |
| `assets/05-db-after-webui.txt` | SQLite：WebUI SSE 轮后（injectedCount=2、新增 reflect/injected sid=WebUI 会话） |
| `assets/06-webui-home.png` | WebUI：首页截图（欢迎页 + 侧栏会话列表） |
| `assets/07-webui-typed.png` | WebUI：输入消息后截图 |
| `assets/08-webui-response.png` | WebUI：回复完成截图（含思考面板 + 消息气泡） |
| `assets/08-webui-page-text.txt` | 同上时刻的 DOM 文本快照 |
| `assets/09-db-after-webui.png` | SQLite：WebUI 界面轮后终态 |
| `assets/09-db-after-webui-shots.txt` | 同上的原始查询输出 |

## 四、现象（逐跳）

### 产卡跳（`--judge`）
- 测试集 2 用例**真跑**：case-greet 通过（暗号回显正确）；case-fail 失败（bash 需审批但评测 Agent 无回调 → 不可恢复终止——与 claude大哥 复验报告的已知观察一致，非本轮缺陷）。
- **产卡 1 张、入库 1 张**：`reflections.db` 创建，卡片 `status=proposed`、`trigger=judge_failed`、lesson 含 judge 结论、事件链第 1 条 `reflect/card-created`。
- 证据指针：`evidence_json` 指向真跑 trace 文件（`reflect/traces/rsi-verify/case-fail.trace.json`）。

### CLI 注入跳（print 模式）
- 对话正常完成（暗号 `CLI注入验证-B2-4e8a` 正确回复，模型真实调用）。
- **卡片被注入**：`status` 从 `proposed` → `injected`（revision 1→2）、`effect_json.injectedCount=1`。
- **记账事件**：`reflect/injected`（seq=3），`payload.sessionId` = CLI 会话 `8ecb8db9…`——注入记账挂在正确的会话上。

### WebUI 注入跳（serve + 界面）
- SSE 轮：对话完成（模型尝试 bash 工具 → 被审批闸拒绝 → 正常收尾，`message-end`）。
- **第二次注入记账**：`injectedCount` 1→2（revision 2→3）、新增 `reflect/injected`（seq=5）`payload.sessionId` = WebUI 会话 `8b37b416…`。
- 浏览器界面轮（截图 06-08）：消息发送/回复/思考面板渲染正常，页面 DOM 确认消息与模型输出在界面上可见。

### 注入计数语义（关键断言）
- `injectedCount` **按会话**递增（CLI 轮 +1、WebUI 轮 +1），**不按装配步数放大**——与 claude大哥 复验口径一致（一次会话只记一次）。
- 事件链完整：`card-created → card-updated → reflect/injected`（CLI）`→ card-updated → reflect/injected`（WebUI）。

## 五、结论

| 验证项 | 判定 |
|---|---|
| 产卡跳（默认路径 `--judge` → `reflections.db` 非空） | ✅ 通过 |
| CLI 注入（卡片 injected + `reflect/injected` 事件 + `injectedCount` 更新） | ✅ 通过 |
| WebUI 注入（同上，且 `injectedCount` 按会话 +1 不放大） | ✅ 通过 |
| 注入不破坏对话（CLI/WebUI 均正常回复） | ✅ 通过 |
| ACP/Multica 侧 | 未在本轮单独验证（需 daemon 环境，见「边界」） |

**RSI 首期 L1 闭环在 CLI 与 WebUI 两条对话方式的默认运行路径上均真实开通。**

## 六、边界与已知观察（如实）

1. **评测 Agent 无工具审批回调**：`--judge` 跑需 bash 的用例会以「requires approval 无 callback」失败——这是已知设计（claude大哥 复验报告同款观察），教训文本如实记录了失败原因，不产假卡。后续可考虑评测路径注入 `unattendedPermissionPolicy: "allow"`。
2. **ACP/Multica 侧未单独跑**：需 daemon 环境 + 峰小弟真机触发，本轮聚焦 CLI + WebUI（任务要求的两条方式均已覆盖）。ACP 侧的 `onReflectionInjected` 接线在 `acp-mode.ts` 已随 `fd49e6a` 合入，机制与 serve 同构。
3. **截图说明**：CLI 终端截图为 print 模式输出 + DB 查询结果的终端风格渲染（`.verify-rsi/render-cli-shots.py`，PIL）；WebUI 截图为真实浏览器 CDP 截图（`.verify-rsi/webui-shots.ts`，headless Chromium）。
4. **数据隔离**：全部验证在 `.verify-rsi/data` 独立数据根下进行，未触碰生产 `.fengagent/` 数据；测试后删除 `.verify-rsi/` 即可清理。

## 七、复跑

```bash
cd D:\AgentCode\FengAgentCli-main
rm -rf .verify-rsi/data   # 从干净状态开始
mkdir -p .verify-rsi/data/testsets
# （写入测试集，参考本报告 assets/ 或 docs/verify/AGE-29-RSI-multimode/ 内的模板）
export FENG_DATA_DIR="$(pwd)/.verify-rsi/data"
bun run eval --judge && bun .verify-rsi/query-db.ts
bun run packages/cli/src/entry.ts --print "任意消息" && bun .verify-rsi/query-db.ts
FENG_SERVER_PORT=3200 bun run serve &  # 浏览器打开 http://127.0.0.1:3200
```
