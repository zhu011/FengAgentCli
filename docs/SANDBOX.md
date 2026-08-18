# 实验沙箱（Sandbox）

## 背景

Agent 执行「实验性操作」——新建/删除临时文件、执行临时代码——如果直接落在
宿主工作目录与宿主环境里，可能误删文件、写坏环境。本模块为这类操作提供**隔离
执行环境**：文件操作全部重定向到独立沙箱根目录，命令在脱敏环境中运行，宿主
文件与凭据不受影响。

## 使用方式（Agent 工具）

内置工具 `sandbox`（与 `bash`、`file-write` 等同级注册），动作如下：

| 动作 | 参数 | 说明 |
|------|------|------|
| `run` | `command`（必填）、`timeout?` | 在沙箱内执行 shell 命令（cmd/sh），输出/退出码/stderr 返回 |
| `write` | `path`、`content` | 在沙箱内写文件（自动建父目录） |
| `read` | `path` | 读沙箱内文件 |
| `delete` | `path` | 删除沙箱内文件/目录（递归） |
| `list` | `path?` | 列出沙箱内内容（递归） |
| `copy-in` | `source`（宿主路径）、`dest?` | 把宿主文件/目录（只读）导入沙箱 |
| `copy-out` | `path`、`dest`（宿主路径） | 把沙箱产物导出到宿主 —— **唯一出口，需权限审批** |
| `status` | — | 查看当前会话沙箱根路径 |

示例：

```
sandbox run     command="node -e \"console.log('tmp ok')\""
sandbox write   path="exp/test.js" content="console.log(1+1)"
sandbox run     command="node exp/test.js > result.txt"
sandbox read    path="result.txt"
sandbox delete  path="exp"
sandbox copy-out path="result.txt" dest="./tmp-result.txt"
```

沙箱按**会话（sessionId）隔离**：同一会话复用同一沙箱根，会话间互不可见。

## 安全模型

1. **路径围栏**：`resolvePath` 归一化后必须落在沙箱根内，`..` 逃逸或沙箱外的
   绝对路径抛 `SandboxEscapeError`（工具层返回错误结果）。
2. **环境脱敏**：子进程环境剔除 `*API_KEY` / `*TOKEN` / `*SECRET` / `*PASSWORD`
   等敏感变量及 `FENG_*`、`MULTICA_*` 前缀；`HOME` / `USERPROFILE` / `TEMP` /
   `TMP` 指向沙箱内目录；注入 `FENG_SANDBOX=1` 标记（临时代码可自检）。
3. **超时强杀**：命令默认 120s 超时；Windows 用 `taskkill /T /F` 杀进程树，
   POSIX 用进程组 `SIGKILL`，防止失控进程残留。
4. **显式数据流通**：宿主 → 沙箱只能走 `copy-in`（源只读）；沙箱 → 宿主只能走
   `copy-out`（工具层权限审批，默认询问用户）。
5. **自动清理**：`dispose()` 递归删除沙箱根（幂等，对瞬时文件锁有限重试）。

## 编程接口（TypeScript）

```ts
import { Sandbox } from "@fengagent/tools";

const sb = new Sandbox(); // 根目录在 os.tmpdir() 下
sb.writeFile("exp/a.txt", "data");
const r = await sb.runCommand("node exp/a.js"); // { exitCode, stdout, stderr, timedOut }
sb.copyOut("exp/a.txt", "/host/dest/a.txt");
sb.dispose();
```

## 设计取舍与已知边界

- **软隔离**：这是「路径围栏 + 环境脱敏」的进程级隔离，不是 OS 级沙箱
  （Docker/bwrap）。刻意 `cd` 出沙箱根的命令仍能访问宿主 —— 用于防误操作、
  防凭据泄露，不防恶意逃逸。
- **输出捕获**：命令以 `( ... )` 子组包裹后重定向到沙箱内文件（非管道），
  兼容受限环境并避免大输出死锁；命令内含未配对括号时需自行转义。
- **copy-out 是唯一出口**：与既有 `file-write` 权限语义一致，需要用户确认。
- 沙箱内的写操作**不触发**权限询问（隔离内安全），与既有 `bash`/`file-write`
  的审批行为相互独立，互不影响。
