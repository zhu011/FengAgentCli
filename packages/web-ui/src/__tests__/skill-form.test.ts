/**
 * 技能库表单 — 输入校验测试（纯函数）。
 */

import { describe, expect, test } from "bun:test";
import {
  EMPTY_SKILL_FORM,
  formToSkillEntry,
  validateSkillForm,
  type SkillFormValue,
} from "../pages/skill-form.ts";

describe("validateSkillForm", () => {
  const base: SkillFormValue = {
    ...EMPTY_SKILL_FORM,
    name: "release-notes",
    description: "生成发版说明",
    prompt: "按团队模板生成发版说明。",
  };

  test("合法表单通过", () => {
    expect(validateSkillForm(base, false)).toEqual([]);
  });

  test("名称规则：空 / 大写 / 下划线 / 连字符开头", () => {
    expect(validateSkillForm({ ...base, name: "" }, false)[0]).toContain("名称");
    expect(validateSkillForm({ ...base, name: "ReleaseNotes" }, false).join()).toContain("名称");
    expect(validateSkillForm({ ...base, name: "release_notes" }, false).join()).toContain("名称");
    expect(validateSkillForm({ ...base, name: "-x" }, false).join()).toContain("名称");
  });

  test("合法 kebab-case 名称（数字/连字符）", () => {
    expect(validateSkillForm({ ...base, name: "code-review" }, false)).toEqual([]);
    expect(validateSkillForm({ ...base, name: "v2-upgrade" }, false)).toEqual([]);
  });

  test("编辑模式不校验名称（以路径名为准）", () => {
    expect(validateSkillForm({ ...base, name: "" }, true)).toEqual([]);
  });

  test("描述与 prompt 必填", () => {
    expect(validateSkillForm({ ...base, description: "" }, false).join()).toContain("描述");
    expect(validateSkillForm({ ...base, prompt: "  " }, false).join()).toContain("prompt");
  });

  test("trigger 可留空", () => {
    expect(validateSkillForm({ ...base, trigger: "" }, false)).toEqual([]);
  });
});

describe("formToSkillEntry", () => {
  test("归一：name/description/trigger 去首尾空白，prompt 保留原文", () => {
    const entry = formToSkillEntry({
      name: " release-notes ",
      description: " 生成发版说明 ",
      trigger: " 请求发版说明时 ",
      prompt: "第一行\n\n第二行  保留空格\n",
    });
    expect(entry).toEqual({
      name: "release-notes",
      description: "生成发版说明",
      trigger: "请求发版说明时",
      prompt: "第一行\n\n第二行  保留空格\n",
    });
  });
});
