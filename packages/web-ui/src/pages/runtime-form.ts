/**
 * @fengagent/web-ui — runtime 管理表单的输入解析与校验（纯函数，供测试）
 *
 * 表单字段是文本形态（args 空格分隔、env 逐行 KEY=VALUE），这里负责
 * 文本 → RuntimeEntryInput 的归一与前端校验；服务端仍做权威校验。
 */

export interface RuntimeFormValue {
  name: string;
  command: string;
  args: string;
  protocol: "acp" | "claude-stream-json";
  env: string;
}

/** 空表单 */
export const EMPTY_RUNTIME_FORM: RuntimeFormValue = {
  name: "",
  command: "",
  args: "",
  protocol: "acp",
  env: "",
};

/** args 文本 → 数组（空白分隔；引号内空格不拆——简化版：先按引号段切） */
export function parseArgsInput(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  // 支持双引号包裹含空格的单个参数："--prompt 两个词" 算一个 arg
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    out.push(m[1] ?? m[2] ?? "");
  }
  return out;
}

/** env 文本（逐行 KEY=VALUE）→ Record；非法行收集为错误 */
export function parseEnvInput(raw: string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      errors.push(`环境变量行缺少 KEY=VALUE 格式：${trimmed.slice(0, 40)}`);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    env[key] = value;
  }
  return { env, errors };
}

/** 表单校验：返回错误列表（空数组 = 通过） */
export function validateRuntimeForm(value: RuntimeFormValue, editing: boolean): string[] {
  const errors: string[] = [];
  if (!editing) {
    const name = value.name.trim();
    if (name === "") errors.push("名称不能为空");
    else if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
      errors.push("名称只能是字母/数字/下划线/连字符（且不以连字符开头）");
    }
  }
  if (value.command.trim() === "") errors.push("command 不能为空");
  errors.push(...parseEnvInput(value.env).errors);
  return errors;
}

/** 表单 → RuntimeEntryInput（已通过校验后调用） */
export function formToEntry(value: RuntimeFormValue): {
  name: string;
  command: string;
  args?: string[];
  protocol: "acp" | "claude-stream-json";
  env?: Record<string, string>;
} {
  const { env } = parseEnvInput(value.env);
  const args = parseArgsInput(value.args);
  return {
    name: value.name.trim(),
    command: value.command.trim(),
    ...(args.length > 0 ? { args } : {}),
    protocol: value.protocol,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
