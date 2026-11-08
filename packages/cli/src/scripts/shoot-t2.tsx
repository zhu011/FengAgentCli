/**
 * T2 验证帧：@ 路径补全面板 + 命令面板分组。
 * ink-testing-library 下 stdin 不可用，补全面板弹出依赖 value 状态——
 * 这里用「带初始值的受控 Input」渲染：initialValue prop 仅测试用。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { Input } from "../tui/input.tsx";

const OUT = join(import.meta.dir, "..", "..", "..", "..", "screenshots", "tui-raw");
mkdirSync(OUT, { recursive: true });
const WORKDIR = join(import.meta.dir, "..", "..", "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function save(name: string, frame: string) {
  writeFileSync(join(OUT, name), frame, "utf-8");
  console.log("[t2] saved", name);
}

// 受控初始值：面板由 value 派生（@token / / 前缀），无需键盘输入
function InitialValueInput({ initial }: { initial: string }) {
  return <InputStub initial={initial} />;
}

// 通过 draft 注入初始值（draft 走 useEffect setValue —— 无需 stdin）
let seq = 1;
function InputStub({ initial }: { initial: string }) {
  return <Input onSubmit={() => {}} draft={{ text: initial, id: seq++ }} workdir={WORKDIR} />;
}

const { lastFrame: atFrame } = render(<InitialValueInput initial="@pack" />);
await sleep(120);
save("t2-at-panel.txt", atFrame() ?? "");

const { lastFrame: cmdFrame } = render(<InitialValueInput initial="/" />);
await sleep(120);
save("t2-cmd-groups.txt", cmdFrame() ?? "");
