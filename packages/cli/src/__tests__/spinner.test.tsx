/**
 * TUI Spinner / 动态图标测试
 *
 * 验证逐帧动画指示器：
 * - SpinnerGlyph 按帧序列渲染
 * - useFrameTicker 单帧稳定
 * - 帧预设表完整
 */

import React from "react";
import { test, expect, describe } from "bun:test";
import { render } from "ink-testing-library";
import { SpinnerGlyph, useFrameTicker, FRAME_PRESETS, resolvePreset } from "../tui/spinner.tsx";
import { ThinkingPet } from "../tui/thinking-pet.tsx";

/** 等待真实定时器推进（验证动画帧随时间切换） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 去除 ANSI 转义序列 */
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("FRAME_PRESETS", () => {
  test("预设表包含常用动画帧", () => {
    expect(FRAME_PRESETS["claude"]).toBeDefined();
    expect(FRAME_PRESETS["moon"]).toBeDefined();
    expect(FRAME_PRESETS["dots"]).toBeDefined();
    expect(FRAME_PRESETS["aesthetic"]).toBeDefined();
  });

  test("resolvePreset 未知预设回退默认", () => {
    const p = resolvePreset("not-exist");
    expect(p.frames.length).toBeGreaterThan(0);
    expect(p.intervalMs).toBeGreaterThan(0);
  });

  test("所有预设帧数 > 0 且间隔 > 0", () => {
    for (const preset of Object.values(FRAME_PRESETS)) {
      expect(preset.frames.length).toBeGreaterThan(0);
      expect(preset.intervalMs).toBeGreaterThan(0);
    }
  });
});

describe("useFrameTicker", () => {
  test("单帧时索引恒为 0（不启动定时器）", () => {
    let frame = -1;
    function Probe(): React.ReactElement {
      frame = useFrameTicker(1, 100);
      return <React.Fragment />;
    }
    render(<Probe />);
    expect(frame).toBe(0);
  });
});

describe("SpinnerGlyph 渲染", () => {
  test("渲染帧序列中的字符", () => {
    const { lastFrame } = render(
      <SpinnerGlyph frames={[">", "-"]} intervalMs={1000} withSpace={false} />,
    );
    const out = lastFrame();
    expect(out).toContain(">");
  });

  test("默认预设渲染非空", () => {
    const { lastFrame } = render(<SpinnerGlyph withSpace={false} />);
    const out = lastFrame() ?? "";
    expect(out.length).toBeGreaterThan(0);
  });

  test("ThinkingPet 渲染动态指示 + 宠物", () => {
    const { lastFrame } = render(<ThinkingPet text="测试中" />);
    const out = lastFrame();
    expect(out).toContain("测试中");
  });
});

describe("动态图标帧推进（真实定时器）", () => {
  test("SpinnerGlyph 的帧随时间切换（useEffect + setInterval 驱动）", async () => {
    // 4 帧、每帧 120ms：两个时刻渲染应出现不同帧字符
    const a = render(
      <SpinnerGlyph frames={["A", "B", "C", "D"]} intervalMs={120} withSpace={false} textVariant={false} />,
    );
    const frame1 = stripAnsi(a.lastFrame() ?? "");
    await sleep(200);
    const frame2 = stripAnsi(a.lastFrame() ?? "");
    await sleep(200);
    const frame3 = stripAnsi(a.lastFrame() ?? "");
    a.unmount();
    const seen = new Set([frame1.trim(), frame2.trim(), frame3.trim()]);
    expect(seen.size).toBeGreaterThan(1);
  });

  test("ThinkingPet 思考点动画随时间推进", async () => {
    const a = render(<ThinkingPet text="思考中" showPet={false} />);
    const f1 = stripAnsi(a.lastFrame() ?? "");
    await sleep(450);
    const f2 = stripAnsi(a.lastFrame() ?? "");
    a.unmount();
    expect(f1).not.toBe(f2);
  });
});
