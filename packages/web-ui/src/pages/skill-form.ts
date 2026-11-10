/**
 * @fengagent/web-ui — 技能库表单的输入校验（纯函数，供测试）
 *
 * 表单字段：名称 / 描述 / trigger / prompt 正文。这里负责前端校验；
 * 服务端仍做权威校验（重名 409、名称规则等）。
 */

import type { SkillEntryInput } from "../api/types.ts";

export interface SkillFormValue {
  name: string;
  description: string;
  trigger: string;
  prompt: string;
}

/** 空表单 */
export const EMPTY_SKILL_FORM: SkillFormValue = {
  name: "",
  description: "",
  trigger: "",
  prompt: "",
};

/** 技能名称规则：小写 kebab-case（与 .md 文件名一致） */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 表单校验：返回错误列表（空数组 = 通过） */
export function validateSkillForm(value: SkillFormValue, editing: boolean): string[] {
  const errors: string[] = [];
  if (!editing) {
    const name = value.name.trim();
    if (name === "") errors.push("名称不能为空");
    else if (!SKILL_NAME_RE.test(name)) {
      errors.push("名称只能是小写字母/数字/连字符（如 code-review），与 .md 文件名一致");
    }
  }
  if (value.description.trim() === "") errors.push("描述不能为空");
  if (value.prompt.trim() === "") errors.push("prompt 正文不能为空");
  return errors;
}

/** 表单 → SkillEntryInput（已通过校验后调用） */
export function formToSkillEntry(value: SkillFormValue): SkillEntryInput {
  return {
    name: value.name.trim(),
    description: value.description.trim(),
    trigger: value.trigger.trim(),
    prompt: value.prompt,
  };
}
