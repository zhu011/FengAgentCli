/**
 * @fengagent/tools — bash 工具方言契约（AGE-29）
 *
 * 现场：`packages/tools/src/builtin/bash.ts` 在 Windows 实走 `cmd.exe /c`，但工具名
 * 叫 `bash`、描述写「PowerShell on Windows」。模型按描述写 `Get-Content`，在 cmd.exe
 * 里报 `'Get-Content' is not recognized`，连续 3 轮全败触发死循环防护终止整轮对话。
 *
 * 本测试固化「名 / 描述 / 实现」三方一致性：
 * 1. 描述里宣布的解释器必须与 `execute()` 真正 spawn 的解释器相同；
 * 2. Windows 优先 PowerShell（与描述的历史承诺一致），仅在 PowerShell 缺失时退 cmd；
 * 3. `metadata.shell` 回带真实解释器，可被外部核对；
 * 4. POSIX 侧语义不变（`$SHELL` + `-c`）。
 *
 * 说明：部分受限执行环境（DSH 沙箱 / CI 沙箱）禁止带管道 stdio 起子进程
 * （`EPERM uv_spawn`）。此处用一次探针判定，起不了进程时只跳过「真跑命令」的断言，
 * 描述一致性、探测逻辑、参数形状等纯静态断言仍然执行。
 */

import { describe, it, expect } from "bun:test";
import {
  createBashTool,
  describeBashTool,
  isExecutableAvailable,
  resolveShell,
  type ResolvedShell,
} from "../builtin/bash.ts";
import type { ToolContext } from "@fengagent/core/tool";

const CONTEXT: ToolContext = {
  workdir: process.cwd(),
  sessionId: "bash-dialect",
  messageId: "bash-dialect-msg",
};

const posixShell: ResolvedShell = {
  command: "/bin/sh",
  args: ["-c"],
  label: "sh",
  dialect: "POSIX shell 语法",
};

const cmdShell: ResolvedShell = {
  command: "C:\\Windows\\system32\\cmd.exe",
  args: ["/c"],
  label: "cmd",
  dialect: "cmd.exe 语法（dir /b、type、findstr；不支持 Get-* cmdlet）",
};

const windowsPowerShell: ResolvedShell = {
  command: "powershell.exe",
  args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
  label: "powershell",
  dialect:
    "Windows PowerShell 语法（原生 cmdlet，如 Get-Content / Get-ChildItem；也接受 ls、cat、pwd 等别名）",
};

/** 探针：本环境是否允许带管道 stdio 起子进程。 */
async function canSpawn(): Promise<boolean> {
  const probe = createBashTool({
    command: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    args: process.platform === "win32" ? ["/c"] : ["-c"],
    label: process.platform === "win32" ? "cmd" : "sh",
    dialect: "probe",
  });
  try {
    const result = await probe.execute({ command: "echo spawn-probe", timeout: 15000 }, CONTEXT);
    return !/Failed to spawn/.test(result.content);
  } catch {
    // 受限沙箱里 spawn 可能同步抛 EPERM（uv_spawn），此时视为不允许起进程。
    return false;
  }
}

const SPAWN_ALLOWED = await canSpawn();

describe("bash 工具 — 名/描述/实现三方一致", () => {
  it("工具名保持 bash（审批、权限语义与历史一致，不改名）", () => {
    expect(createBashTool(posixShell).name).toBe("bash");
  });

  it("描述宣布的解释器 = 实现真正 spawn 的解释器（PowerShell 档）", async () => {
    const tool = createBashTool(windowsPowerShell);
    // 描述点名 PowerShell 方言与真实 cmdlet
    expect(tool.description).toContain("powershell");
    expect(tool.description).toContain("Get-Content");
    // 工具名与引擎的落差必须被显式声明，模型才不会照 bash 肌肉记忆写
    expect(tool.description).toContain("named `bash` for historical reasons");

    if (!SPAWN_ALLOWED) return;
    const result = await tool.execute({ command: "echo dialect-probe", timeout: 20000 }, CONTEXT);
    expect((result.metadata as Record<string, unknown>)["shell"]).toBe("powershell");
    expect(result.content).toContain("dialect-probe");
  });

  it("描述宣布的解释器 = 实现真正 spawn 的解释器（cmd 档）", async () => {
    const tool = createBashTool(cmdShell);
    expect(tool.description).toContain("cmd");

    if (!SPAWN_ALLOWED) return;
    const result = await tool.execute({ command: "echo dialect-probe", timeout: 20000 }, CONTEXT);
    expect((result.metadata as Record<string, unknown>)["shell"]).toBe("cmd");
    expect(result.content).toContain("dialect-probe");
  });

  it("cmd 档描述不得给 PowerShell 方言承诺（这是本轮缺陷的原始形态）", () => {
    const description = describeBashTool(cmdShell);
    expect(description).toContain("cmd");
    expect(description.toLowerCase()).not.toContain("get-content");
    expect(description.toLowerCase()).not.toContain("powershell");
    // 反向：PowerShell 档必须给 PowerShell 承诺
    expect(describeBashTool(windowsPowerShell)).toContain("Get-Content");
  });

  it("POSIX 档：$SHELL + -c 语义不变", () => {
    const shell = resolveShell("linux");
    expect(shell.label).toBe("sh");
    expect(shell.args).toEqual(["-c"]);
    expect(shell.command.length).toBeGreaterThan(0);
  });

  it("win32 解析结果必须是 pwsh / powershell / cmd 之一，且描述与其相符", () => {
    const shell = resolveShell("win32");
    expect(["pwsh", "powershell", "cmd"]).toContain(shell.label);
    if (shell.label === "cmd") {
      expect(shell.args).toEqual(["/c"]);
    } else {
      expect(shell.args).toContain("-Command");
      expect(shell.args).toContain("-NoProfile");
    }
    expect(describeBashTool(shell)).toContain(shell.label);
  });

  it("win32 上主机若装了 PowerShell，就必须解析到 PowerShell（不再默认 cmd）", () => {
    if (process.platform !== "win32") return;
    const shell = resolveShell("win32");
    expect(shell.label === "powershell" || shell.label === "pwsh").toBe(true);
  });

  it("解释器探测是纯文件系统判断：认识真命令名、否决不存在的命令名", () => {
    if (process.platform === "win32") {
      expect(isExecutableAvailable("cmd.exe")).toBe(true);
    } else {
      expect(isExecutableAvailable("/bin/sh")).toBe(true);
    }
    expect(isExecutableAvailable("definitely-not-a-real-shell-xyz")).toBe(false);
  });

  it("渲染前缀报告真实解释器，不再谎称 bash", () => {
    expect(createBashTool(cmdShell).renderUse!({ command: "dir /b" })).toBe("cmd: dir /b");
    expect(createBashTool(posixShell).renderUse!({ command: "ls -la" })).toBe("sh: ls -la");
  });

  it("spawn 失败时报出解释器名与路径（便于排查方言/环境问题）", async () => {
    const bogus = createBashTool({
      command: "definitely-not-a-real-shell-xyz",
      args: ["-c"],
      label: "sh",
      dialect: "POSIX shell 语法",
    });
    const result = await bogus.execute({ command: "echo hi", timeout: 10000 }, CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("definitely-not-a-real-shell-xyz");
  });
});
