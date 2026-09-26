两步探针都跑了，结论是：**A 的坎不在我们桥的会话仓处理，在守护进程这条路径根本没把契约交给运行时**。同时桥自身确有一处会直接掐断对话闭环的缺陷，已修。

## 探针 1 — 守护进程实际注入子进程的环境变量

本任务（`01a0ddfa-ba5e-...`，runtime `d3630c9e`，`hermes` + 自定义命令 `dsh-acp.exe acp`）里全量枚举 `env:`，守护进程给的 `MULTICA_*` 只有 9 个：`AGENT_ID / AGENT_NAME / DAEMON_PORT / SERVER_URL / TASK_CONFIG_ROOT / TASK_ID / TASK_SLOT / TASK_WORKSPACES_ROOT / WORKSPACE_ID`。

- **没有 `MULTICA_DSH_SESSION_ROOT`** —— 没给会话根。这个名字确实在守护进程二进制里（`create hermes session store` / `publish hermes session link` / `mklink /J` 同区），所以是「这条路径没注入」，不是「契约不存在」。
- **没有 `MULTICA_TOKEN`** —— 下面第 2 条修复就是它。
- `MULTICA_DAEMON_PORT=19681` 本机**无监听**（`Get-NetTCPConnection -State Listen` 为空），回连守护进程取契约这条路不通。
- 排除「DSH 覆盖」：`~/.dsh/profiles/node_modules/@deepseek-ai/**` 全文检索 `MULTICA_` **零命中**，`dsh-shell-env` 只重置继承来的 `DSH_*`。环境里没有 = 守护进程没给。

## 探针 2 — 同机对照：参考实现同样 `resume_reachable=false`

被要求对照的 runtime `d3630c9e` 就是本任务自己。守护进程日志：

```
22:36:04.613 dropping prior session: session store not reachable from this run
             provider=hermes session_home_reachable=false
22:36:04.622 starting agent ... provider=hermes resume_reachable=false
22:36:13.044 hermes session created session_id=ffdcff81-...
```

同一 workdir 下其它 provider 是可达的：`provider=claude resume_reachable=true`（并真的 `resuming session`）、`provider=opencode ... resume_reachable=true`。更早两个 DSH 任务（`01a0ddf0-88a8`、`01a0ddf4-a721`）完全同现象。**按你给的判据落在「此契约对所有 hermes 运行时是同一道坎」这一侧**——不是我们桥的差异。

## 根因（文件系统级）

守护进程**建了仓、却没把仓挂到运行时写得到的地方**：

1. `~/.multica/profiles/desktop-api.multica.ai/hermes-sessions/<agent_id>/default/<thread_id>/` 按契约建出来了，**整树 0 文件**（普通目录，非链接）。
2. 本次运行的 task hermes-home 里，`memories` 挂对了（→ `hermes-state/<agent>/default`），但 **`sessions` 指向的是全局共享目录 `~\AppData\Local\hermes\sessions`，而不是它刚建的会话仓**。
3. 那个全局目录是**空的**；DSH 实际把会话写在 `~/.dsh/sessions/<cwd 派生目录>/`。
4. **不是个例**：两个工作区下 **65/65** 个 task env root 的 `hermes-home\sessions` 目标全是那个全局目录。

所以守护进程在 A 建仓、把可写位置指到 B、运行时写在 C，下一轮在 A 找不到前会话 → `session_home_reachable=false` → 丢会话 → `resume_session=false`。**桥没法「认领 daemon 给的会话根」，因为 daemon 没给**；桥能做的只有「一旦给了就认」。

## 桥侧修复（`def0edf`，两处，未设变量时零行为变化）

1. `packages/tools/src/sandbox.ts` — **这是对话闭环的硬阻塞**：`scrubEnv` 原本把 `MULTICA_*` 全量剥离，而 `MULTICA_TOKEN` 又同时命中 `SECRET_PATTERN`，于是桥下每个 `bash`/`pwsh` 都拿不到 task 凭据，`multica` CLI 直接拒绝工作（`agent execution context requires MULTICA_TOKEN to be a task-scoped mat_ token`），agent 读不到 issue、发不出评论，只能凭记忆/读文件作答。现在 `RUNTIME_CONTRACT_ENV` 白名单（TOKEN / TASK_ID / AGENT_ID / WORKSPACE_ID / SERVER_URL / DAEMON_PORT / DSH_SESSION_ROOT / DSH_PLUGIN_PATH / TASK_CONFIG_ROOT / TASK_WORKSPACES_ROOT / AUTOPILOT_RUN_ID）在 `SECRET_PATTERN` **之前**判定透传；其余 `MULTICA_*`、`FENG_*`、`*_API_KEY`/`*_TOKEN` 照旧剥离。平台自身的约束也指向同一结论：CLI 提示写死「Only the runtime that started this task can supply a valid task token」，所以桥必须原样交出守护进程给的那一个凭据，不能在桥内换身份。
2. `packages/shared/src/data-root.ts` + `packages/cli/src/acp-mode.ts` — 新增 `resolveSessionStoreRoot()`：`MULTICA_DSH_SESSION_ROOT` 存在时以它作为会话仓根（优先于 `FENG_DATA_DIR`），未设置/空串完全退回 `resolveDataRoot()`；ACP 的 `storeFor()` 改用它，桥的 `sessions.db` 才会落进守护进程判定的那个仓。

## 验收

```
bun test packages/shared/<data-root> + packages/tools/<sandbox>   39 pass / 0 fail
bun test packages/tools packages/shared packages/cli             434 pass / 0 fail
bun run typecheck                                                exit 0
```

现场记录与全部证据：`docs/verify/AGE-29-session-resume-probe.md`（同 commit）。

## 需要守护进程侧（或平台侧）

1. 把 `MULTICA_DSH_SESSION_ROOT`（指向 `hermes-sessions/<agent_id>/default/<thread_id>`）注入所有 provider 的运行时子进程，并让 task hermes-home 的 `sessions` 链接指向该仓 —— 当前 65/65 个 task env root 都指错。
2. 同一条 hermes + 自定义命令路径不注入 `MULTICA_TOKEN`：修好之前，跑在这条路径上的 agent 都拿不到 issue 上下文（本条回复所在的运行也受影响）。
3. 若守护进程侧短期不可改，替代方向是让 `runtime profile` 声明本桥需要的 env 契约，而不是让桥猜路径 —— 猜路径已被明确判为不可采信。

B 项（图三件套）不在本轮改动内，仍留在 `23b5cf2` 交 claude大哥 按第四节判据验收。
