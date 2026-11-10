/**
 * @fengagent/web-ui — 团队级技能库的 mock 后端（P0）
 *
 * 后端（/api/skills）落地前的演示数据源：技能库页探测失败时自动回退。
 * 契约与 client.ts 技能方法一一对齐，错误抛 ApiError（与真实后端
 * `{error:{message,code}}` 同形），页面无需区分真实/mock。
 *
 * 合并视图语义：列出所有层的定义（内置/团队/本目录），同名时高优先层
 * （workdir > team > builtin）胜出，被覆盖的定义带 `overriddenBy`
 * 指向覆盖它的层 —— 管理界面正是要能看出「/skill 行为为什么和团队版不一样」。
 * 启停是名字级状态：停用 = 该技能对 agent 侧不可见，无论由哪层定义。
 */

import { ApiError } from "./client.ts";
import type { SkillEntryInput, SkillInfo, SkillSourceLayer } from "./types.ts";

/** 层优先级（大者胜出） */
const LAYER_ORDER: Record<SkillSourceLayer, number> = { builtin: 0, team: 1, workdir: 2 };

/** 来源层 → 展示标签 */
export const SKILL_SOURCE_LABEL: Record<SkillSourceLayer, string> = {
  builtin: "内置",
  team: "团队",
  workdir: "本目录",
};

/** 技能库数据源（client 与 mock 共同满足；页面统一走这个接口） */
export interface SkillLibrarySource {
  listSkills(merge?: boolean): Promise<SkillInfo[]>;
  getSkill(name: string): Promise<SkillInfo>;
  createSkill(req: SkillEntryInput): Promise<SkillInfo[]>;
  updateSkill(name: string, patch: Partial<SkillEntryInput>): Promise<SkillInfo[]>;
  deleteSkill(name: string): Promise<SkillInfo[]>;
  resetSkill(name: string): Promise<SkillInfo[]>;
}

function builtin(name: string, description: string, trigger: string, prompt: string): SkillInfo {
  return { name, description, trigger, prompt, source: "builtin", enabled: true };
}

/** mock 技能库（页面实例持有，仅演示；CRUD 内存生效） */
export class SkillsMock implements SkillLibrarySource {
  /** 三层定义（name → 各层条目） */
  private layers = new Map<string, Map<SkillSourceLayer, SkillInfo>>();
  /** 名字级启停（停用 = 对 agent 侧不可见） */
  private disabledNames = new Set<string>();

  constructor() {
    const seed = (skill: SkillInfo, layer: SkillSourceLayer) => {
      const byLayer = this.layers.get(skill.name) ?? new Map<SkillSourceLayer, SkillInfo>();
      byLayer.set(layer, skill);
      this.layers.set(skill.name, byLayer);
    };

    // 内置 4 个（与 tools 包 BUILTIN_SKILLS 对应，prompt 取演示缩短版）
    seed(builtin("code-review", "代码审查技能 — 系统性地审查代码质量、安全性和最佳实践", "当用户请求代码审查、review 代码或检查代码质量时使用", "你是代码审查专家。按正确性/安全性/性能/可读性/一致性五个维度审查，按严重程度分类输出。"), "builtin");
    seed(builtin("debug", "调试辅助技能 — 系统性地定位和修复 bug", "当用户遇到 bug、错误或异常行为需要调试时使用", "你是调试专家。按复现→定位→分析→修复→验证五步定位问题，用证据说话，不做无根据猜测。"), "builtin");
    seed(builtin("refactor", "重构建议技能 — 识别代码异味并提供重构方案", "当用户请求重构、优化代码结构或改善代码质量时使用", "你是重构专家。识别代码异味，评估风险收益，给出可独立验证的分步方案，保持外部行为不变。"), "builtin");
    seed(builtin("test", "测试编写技能 — 编写高质量单元测试和集成测试", "当用户请求编写测试、增加测试覆盖或修复测试时使用", "你是测试专家。遵循 Arrange-Act-Assert 三段式、单一职责、描述性命名，覆盖正常/边界/异常/空值。"), "builtin");

    // 团队级共享示例
    seed({ name: "release-notes", description: "发版说明技能 — 按团队模板生成 CHANGELOG 与发版公告", trigger: "当用户请求生成发版说明、变更日志或版本公告时使用", prompt: "按团队模板生成发版说明：先归类变更（新增/修复/破坏性），再按用户视角重写每条，最后附升级注意事项。", source: "team", enabled: true }, "team");

    // 本目录覆盖示例：workdir 的 debug.md 覆盖内置 debug
    seed({ name: "debug", description: "本目录定制版调试技能 — 额外要求先跑测试再定位", trigger: "当用户遇到 bug 需要调试时使用（本目录定制版）", prompt: "先跑一遍现有测试确认基线，再按复现→定位→分析→修复→验证定位问题。", source: "workdir", enabled: true }, "workdir");
  }

  /** 同名各层按优先级排序（胜出者在前） */
  private sortedLayers(name: string): Array<[SkillSourceLayer, SkillInfo]> {
    const byLayer = this.layers.get(name);
    if (!byLayer) return [];
    return [...byLayer.entries()].sort((a, b) => LAYER_ORDER[b[0]] - LAYER_ORDER[a[0]]);
  }

  /** 合并视图：所有层定义平铺，同名被覆盖的带 overriddenBy，启停为名字级 */
  private merged(): SkillInfo[] {
    const out: SkillInfo[] = [];
    for (const name of this.layers.keys()) {
      const entries = this.sortedLayers(name);
      const winner = entries[0]![0];
      const enabled = !this.disabledNames.has(name);
      for (const [layer, skill] of entries) {
        out.push({
          ...skill,
          enabled,
          ...(layer === winner ? {} : { overriddenBy: winner }),
        });
      }
    }
    return out;
  }

  /** 团队级视图（仅 team 层） */
  private teamOnly(): SkillInfo[] {
    const out: SkillInfo[] = [];
    for (const name of this.layers.keys()) {
      const skill = this.layers.get(name)?.get("team");
      if (skill) out.push({ ...skill, enabled: !this.disabledNames.has(name) });
    }
    return out;
  }

  async listSkills(merge = false): Promise<SkillInfo[]> {
    return merge ? this.merged() : this.teamOnly();
  }

  async getSkill(name: string): Promise<SkillInfo> {
    const entries = this.sortedLayers(name);
    if (entries.length === 0) {
      throw new ApiError(`技能「${name}」不存在`, 404, "not_found");
    }
    // 合并语义：返回胜出层（workdir > team > builtin）
    return { ...entries[0]![1], enabled: !this.disabledNames.has(name) };
  }

  async createSkill(req: SkillEntryInput): Promise<SkillInfo[]> {
    if (this.layers.get(req.name)?.has("team")) {
      throw new ApiError(`技能「${req.name}」已存在（团队级）`, 409, "conflict");
    }
    const byLayer = this.layers.get(req.name) ?? new Map<SkillSourceLayer, SkillInfo>();
    byLayer.set("team", {
      name: req.name,
      description: req.description,
      trigger: req.trigger,
      prompt: req.prompt,
      source: "team",
      enabled: true,
    });
    this.layers.set(req.name, byLayer);
    if (req.enabled === false) this.disabledNames.add(req.name);
    return this.merged();
  }

  async updateSkill(name: string, patch: Partial<SkillEntryInput>): Promise<SkillInfo[]> {
    const byLayer = this.layers.get(name);
    if (!byLayer) {
      throw new ApiError(`技能「${name}」不存在`, 404, "not_found");
    }
    // 启停是名字级状态，与内容字段分开处理
    if (patch.enabled !== undefined) {
      if (patch.enabled) this.disabledNames.delete(name);
      else this.disabledNames.add(name);
    }
    const hasContent =
      patch.description !== undefined ||
      patch.trigger !== undefined ||
      patch.prompt !== undefined;
    if (hasContent) {
      // 编辑内置/本目录条目 = 在团队级创建/更新同名覆盖（同名覆盖语义）
      const current = byLayer.get("team") ?? {
        name,
        description: "",
        trigger: "",
        prompt: "",
        source: "team" as const,
        enabled: true,
      };
      byLayer.set("team", {
        ...current,
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      });
    }
    return this.merged();
  }

  async deleteSkill(name: string): Promise<SkillInfo[]> {
    const byLayer = this.layers.get(name);
    if (!byLayer) {
      throw new ApiError(`技能「${name}」不存在`, 404, "not_found");
    }
    if (!byLayer.has("team")) {
      const isBuiltin = byLayer.has("builtin");
      throw new ApiError(
        isBuiltin
          ? `内置技能「${name}」不能删除，只能恢复默认（reset）或用团队级同名覆盖`
          : `本目录技能「${name}」是 workdir 下的 .md 文件，请直接编辑该文件`,
        409,
        "conflict",
      );
    }
    byLayer.delete("team");
    if (byLayer.size === 0) this.layers.delete(name);
    return this.merged();
  }

  async resetSkill(name: string): Promise<SkillInfo[]> {
    const byLayer = this.layers.get(name);
    if (!byLayer?.has("builtin")) {
      throw new ApiError(`技能「${name}」不是内置技能，没有可恢复的默认版本`, 404, "not_found");
    }
    // 恢复默认 = 移除团队级覆盖；workdir 下的本地文件不动（那是用户自己的文件）
    byLayer.delete("team");
    return this.merged();
  }
}
