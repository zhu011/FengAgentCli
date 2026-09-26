# AGE-29 · A 项（session/resume 生产未生效）现场探针与结论

本文件记录 **2026-09-26 22:36 在真机（runtime `d3630c9e`，provider `hermes`，命令
`C:\Users\17261\.local\bin\dsh-acp.exe acp`）上的两步决定性探针结果**，以及据此定位到的
根因与本次落地的桥侧修复。

触发背景：`57e148b` 声明了 ACP `agentCapabilities.loadSession` 后，claude大哥 终验仍判
「未通过」。opencode二弟 给出的假设是「我们的桥从没往 daemon 指定的会话仓写过会话」，
并要求先做两步探针（子进程实际环境变量 / 同机 DSH 参照运行）。

结论先行：**两步探针都把矛头指向守护进程侧的运行时契约缺失，而不是桥没写仓。**
同时桥自身确有一处会直接掐断对话闭环的缺陷（`MULTICA_*` 全量脱敏），本次已修。

---

## 探针 1 — 守护进程实际注入子进程的 `MULTICA_*` 环境变量

在本任务（`MULTICA_TASK_ID=01a0ddfa-ba5e-79cb-a51c-ddfbaddadf17`）的 agent 侧执行
`Get-ChildItem env:` 全量枚举，守护进程注入的 `MULTICA_*` 只有 9 个：

```
MULTICA_AGENT_ID=ef81dfc3-e30f-4e3e-82e5-bf6d5aaf8ba0
MULTICA_AGENT_NAME=DSH资深开发
MULTICA_DAEMON_PORT=19681
MULTICA_SERVER_URL=https://api.multica.ai
MULTICA_TASK_CONFIG_ROOT=...\age-29-ddfbaddadf17\multica-config
MULTICA_TASK_ID=01a0ddfa-ba5e-79cb-a51c-ddfbaddadf17
MULTICA_TASK_SLOT=12
MULTICA_TASK_WORKSPACES_ROOT=C:\Users\17261\multica_workspaces_desktop-api.multica.ai
MULTICA_WORKSPACE_ID=37bd52b3-114d-450a-ac77-85ba6cf71b5c
```

即：

- **没有 `MULTICA_DSH_SESSION_ROOT`** —— 守护进程**没有**把会话仓位置交给运行时。
  （该名字确实存在于守护进程二进制里，见下文「证据 E3」，所以这是「这条路径没注入」，
  不是「契约不存在」。）
- **没有 `MULTICA_TOKEN`** —— 子进程拿不到 task-scoped `mat_` 凭据。
- `MULTICA_DAEMON_PORT=19681` 在本机**没有监听者**（`Get-NetTCPConnection -State Listen
  -LocalPort 19681` 为空），所以它不是运行时可以回连守护进程取契约的句柄。
- 该变量集与运行时无关地一致：`C:\Users\17261\.dsh\profiles\node_modules\@deepseek-ai\**`
  全文检索 `MULTICA_` / `MULTICA_TOKEN` / `MULTICA_DSH_SESSION_ROOT` **零命中** ——
  即 DSH 侧根本不认识这些变量，不会构造、也不会覆盖它们（`dsh-shell-env` 只重置继承来的
  `DSH_*`）。所以「环境里没有」=「守护进程没给」。

## 探针 2 — 同机参照：**参考实现 DSH 运行时同样 `resume_reachable=false`**

被要求做对照的 runtime `d3630c9e`（dsh-TUI）**就是本次任务自己跑的运行时**。守护进程日志
（`~/.multica/profiles/desktop-api.multica.ai/daemon.log`）：

```
22:36:04.613 INF dropping prior session: session store not reachable from this run
             component=daemon task=01a0ddfa-ba5e-79cb-a51c-ddfbaddadf17 provider=hermes
             session_id=093a4528-c0bd-4a14-98f4-f5665c42af7b
             prior_workdir=D:\AgentCode\FengAgentCli workdir=D:\AgentCode\FengAgentCli
             session_home_reachable=false
22:36:04.622 INF starting agent ... provider=hermes workdir=D:\AgentCode\FengAgentCli
             model="" resume_reachable=false
22:36:04.623 DBG invoking backend ... prompt_bytes=4677 ... resume_session=false
22:36:13.044 INF hermes session created component=daemon session_id=ffdcff81-c900-4baf-96a5-98e2349ca37b
```

同一现象在更早的 DSH 任务 `01a0ddf0-88a8-...`、`01a0ddf4-a721-...` 上完全相同
（`session_home_reachable=false`）。

对照之下，**不是 hermes 的其它 provider 在同一 workdir 是可达的**：

```
21:42:33.552 INF starting agent ... provider=claude workdir=D:\AgentCode\FengAgentCli resume_reachable=true
21:42:33.552 INF resuming session ... session_id=8a8a3703-f0d2-4e73-8e14-4a4470ecb772
22:26:45.995 INF starting agent ... provider=opencode workdir=...\age-29-55a82cf6c081\workdir resume_reachable=true
```

**判定：`session_home_reachable=false` 对「hermes + 自定义运行时命令（dsh-acp）」这条路径是
所有运行时同一道坎 —— 参考实现 dsh-acp 也一样撞上，差异不在我们的桥的会话仓处理。**
所以 opencode二弟 给的「true 则差异在我们桥；false 则此契约对所有 hermes 运行时是同一道坎」
判据，落到了**后者**。

---

## 根因：守护进程**建了会话仓、却没把仓挂到运行时写得到的地方**

文件系统级证据（`~/.multica/profiles/desktop-api.multica.ai/`）：

1. 守护进程确实按契约建了 **每 (agent, thread) 一个会话仓**，但**整树 0 文件**：

   ```
   hermes-sessions\ef81dfc3-e30f-4e3e-82e5-bf6d5aaf8ba0\default\53b2f373-2713-45dc-a8b4-6e48411bdc00\   （空）
   hermes-sessions\5defa517-eb60-4610-a13a-1956e614b6c3\default\{53b2f373-...,chat_01a09add-...,...}   （全空）
   ```

   目录是普通目录（`mode=d-----`，无 `LinkType`），不是链接。`hermes-state/<agent>/default` 同样是空目录。

2. 本次运行的 `HERMES_HOME`（`...\age-29-ddfbaddadf17\hermes-home`）里，守护进程发布的各种
   「链接」中，**`sessions` 指向的是全局共享目录，而不是它刚建的那个会话仓**：

   ```
   memories -> C:\Users\17261\.multica\profiles\desktop-api.multica.ai\hermes-state\ef81dfc3-...\default   ← 这一个是按 agent 挂的
   sessions -> C:\Users\17261\AppData\Local\hermes\sessions                                                ← 指向全局源 home
   ```

3. `C:\Users\17261\AppData\Local\hermes\sessions` **是空目录**（0 项）；真正的 DSH 会话落在
   `C:\Users\17261\.dsh\sessions\<cwd 派生目录>\`（本次 `DSH_SESSION_JSONL=C:\Users\17261\.dsh\sessions\--D-AgentCode-FengAgentCli--\ffdcff81-...`）。

4. 这个 `sessions -> 全局源 home` 的指向**不是个例**：两个工作区下 **65 个** task env root
   的 `hermes-home\sessions` 目标**全部**是 `C:\Users\17261\AppData\Local\hermes\sessions`，
   没有任何一个是 `...\hermes-sessions\<agent_id>\default\<thread_id>`。

于是闭环断裂：守护进程把仓建在 A，把运行时可写的 `sessions` 指到 B，运行时（DSH）实际写在 C，
下一轮守护进程在 A 里找不到上一轮的会话 → `session_home_reachable=false` → 丢掉前会话 →
`resume_session=false` → `session/resume` 永远走不到。

**这一步不是桥能靠「认领 daemon 给的会话根」解决的：daemon 根本没有把会话根给出来**
（探针 1）。桥能做的只有：一旦守护进程真的给了 `MULTICA_DSH_SESSION_ROOT`，就认它。

### 证据 E3（守护进程二进制里的契约字符串）

`multica.exe`（v0.5.0，`...\@multicadesktop\resources\app.asar.unpacked\resources\bin\multica.exe`）
的字符串表里确实有这条契约：

```
MULTICA_AUTOPILOT_RUN_ID  MULTICA_DSH_SESSION_ROOT
execenv: prune hermes session store failed
create hermes session store %s: %w
publish hermes session link %s: %w
session_home_reachable   resume_reachable
mklink /J %s %s: %s: %w
/api/daemon/tasks/%s/session     /api/daemon/tasks/claim
```

即：建仓（`create hermes session store`）、挂链接（`publish hermes session link`，Windows 上是
`mklink /J`）、以及 `MULTICA_DSH_SESSION_ROOT` 这条 env 契约都在守护进程里 —— 只是**没有作用在
hermes + 自定义运行时命令这条生产路径上**（探针 1/2）。注意 `memories` 的链接是挂对了的，
说明 `execenv` 的链接发布机制本身在跑，只是 `sessions` 这一项的目标算错了。

---

## 本次落地的桥侧修复（两处，均为「变量缺失时行为不变」）

### 1. `packages/tools/src/sandbox.ts` — 平台运行时契约变量不再被脱敏（**这条是对话闭环的硬阻塞**）

`scrubEnv` 原本把 `MULTICA_*` 全量剥离（注释写着「运行时凭据/工作区信息」），而
`MULTICA_TOKEN` 又同时命中 `SECRET_PATTERN`。结果：桥下每个 `bash` / `pwsh` 工具调用都拿不到
task 凭据，`multica` CLI 直接拒绝工作：

```
agent execution context requires MULTICA_TOKEN to be a task-scoped mat_ token
```

agent 于是读不到 issue、也发不出评论，只能凭记忆/读文件作答 —— 这正是被 claude大哥 判为
「凭记忆答对路径不可采信」的那种现场。现在 `RUNTIME_CONTRACT_ENV` 白名单（`MULTICA_TOKEN`、
`MULTICA_TASK_ID`、`MULTICA_AGENT_ID`、`MULTICA_WORKSPACE_ID`、`MULTICA_SERVER_URL`、
`MULTICA_DAEMON_PORT`、`MULTICA_DSH_SESSION_ROOT`、`MULTICA_DSH_PLUGIN_PATH`、
`MULTICA_TASK_CONFIG_ROOT`、`MULTICA_TASK_WORKSPACES_ROOT`、`MULTICA_AUTOPILOT_RUN_ID`）
在 `SECRET_PATTERN` **之前**判定并透传；其它 `MULTICA_*`（如 `MULTICA_GC_*`）与
`FENG_*`、各类 `*_API_KEY` / `*_TOKEN` 仍照旧剥离。

> 平台自身的约束也指向同一结论：CLI 侧的提示写死了
> 「This task token was rejected and is no longer usable … do not fall back to a profile or
> member credential … Only the runtime that started this task can supply a valid task token.」
> 所以桥必须把**守护进程给的那一个** task 凭据原样交给工具，而不能在桥内改换身份。

### 2. `packages/shared/src/data-root.ts` + `packages/cli/src/acp-mode.ts` — 认领守护进程给的会话根

新增 `resolveSessionStoreRoot(opts)`：`MULTICA_DSH_SESSION_ROOT` 设置时以它作为会话仓根
（优先级高于 `FENG_DATA_DIR`），未设置/空串时**完全退回** `resolveDataRoot()`。
ACP 的 `storeFor()` 改用它，于是桥的会话库 `sessions.db` 会落进守护进程判定的那个仓，
`session_home_reachable` 才有机会为 true（否则桥再怎么实现 `session/resume` 也没人叫它）。

在**当前**生产路径上该变量不存在，所以这条改动**是零行为变化**的——它只是让桥具备「守护进程
一旦给出会话根就认领」的能力；真正的解锁仍需要守护进程把 `MULTICA_DSH_SESSION_ROOT` 注入
hermes/自定义命令路径，并把 `hermes-home\sessions` 指向它建的那个仓。

### 验证

```
bun test packages/shared/src/__tests__/data-root.test.ts packages/tools/src/__tests__/sandbox.test.ts  → 39 pass / 0 fail
bun test packages/tools packages/shared packages/cli                                                  → 434 pass / 0 fail
bun run typecheck                                                                                     → exit 0
```

---

## 留给下一步（需要守护进程侧，或缺它的替代路径）

1. **守护进程**：把 `MULTICA_DSH_SESSION_ROOT`（指向
   `~/.multica/profiles/<profile>/hermes-sessions/<agent_id>/default/<thread_id>`）注入所有
   provider 的运行时子进程，并让 task hermes-home 的 `sessions` 链接指向该仓，而不是
   `C:\Users\17261\AppData\Local\hermes\sessions`。当前 65/65 个 task env root 都指错。
2. **`MULTICA_TOKEN` 同理**：hermes + 自定义运行时命令路径当前不给 task 凭据，桥下 agent
   无法使用 `multica` CLI（本轮即因此无法回帖）。这一条修好之前，任何运行在该路径上的 agent
   都拿不到 issue 上下文。
3. 若守护进程侧短期不可改，可考虑的替代是：由 `runtime profile` 声明本桥需要的 env 契约
   （需要平台支持），而不是让桥去猜路径 —— 猜路径已被明确判为不可采信。
