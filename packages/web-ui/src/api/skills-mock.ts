/**
 * @fengagent/web-ui — 团队级技能库的 mock 后端（对齐 DSH 4c67aca 契约）
 *
 * 后端（/api/skills）未就绪时的演示数据源：技能库页探测失败时自动回退。
 * 契约与 client.ts 技能方法一一对齐（列表回 SkillListView 对象、CRUD 回
 * 单条 SkillView、错误抛 ApiError 与 `{error:{message,code}}` 同形）。
 *
 * 合并视图语义：skills = 每名字一条胜出项（workdir > team > builtin），
 * layers = 逐层明细（被覆盖的带 overriddenBy）——管理界面正是要能看出
 * 「/skill 行为为什么和团队版不一样」。启停是名字级状态：
 * 停用 = 该技能对 agent 侧不可见，无论由哪层定义。
 */

import { ApiError } from "./client.ts";
import type {
  SkillEntryInput,
  SkillInfo,
  SkillListView,
  SkillShadowedLayer,
  SkillSourceLayer,
} from "./types.ts";

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
  listSkills(merge?: boolean): Promise<SkillListView>;
  getSkill(name: string): Promise<SkillInfo>;
  createSkill(req: SkillEntryInput): Promise<SkillInfo>;
  updateSkill(name: string, patch: Partial<SkillEntryInput>): Promise<SkillInfo>;
  deleteSkill(name: string): Promise<{ ok: boolean; name: string }>;
  resetSkill(name: string): Promise<SkillInfo>;
}

function builtin(name: string, description: string, trigger: string, prompt: string): SkillInfo {
  return { name, description, trigger, prompt, source: "builtin", enabled: true, editable: false, shadowed: [] };
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
    seed({ name: "release-notes", description: "发版说明技能 — 按团队模板生成 CHANGELOG 与发版公告", trigger: "当用户请求生成发版说明、变更日志或版本公告时使用", prompt: "按团队模板生成发版说明：先归类变更（新增/修复/破坏性），再按用户视角重写每条，最后附升级注意事项。", source: "team", enabled: true, editable: true, shadowed: [] }, "team");

    // 本目录覆盖示例：workdir 的 debug.md 覆盖内置 debug
    seed({ name: "debug", description: "本目录定制版调试技能 — 额外要求先跑测试再定位", trigger: "当用户遇到 bug 需要调试时使用（本目录定制版）", prompt: "先跑一遍现有测试确认基线，再按复现→定位→分析→修复→验证定位问题。", source: "workdir", enabled: true, editable: false, shadowed: [] }, "workdir");
  }

  /** 同名各层按优先级排序（胜出者在前） */
  private sortedLayers(name: string): Array<[SkillSourceLayer, SkillInfo]> {
    const byLayer = this.layers.get(name);
    if (!byLayer) return [];
    return [...byLayer.entries()].sort((a, b) => LAYER_ORDER[b[0]] - LAYER_ORDER[a[0]]);
  }

  /** 胜出层（workdir > team > builtin；名字级启停生效） */
  private winner(name: string): SkillInfo | undefined {
    const entries = this.sortedLayers(name);
    if (entries.length === 0) return undefined;
    const [, skill] = entries[0]!;
    return { ...skill, enabled: !this.disabledNames.has(name) };
  }

  /** 列表视图（merge=1 时三层全量 + 逐层明细；否则只回团队层） */
  async listSkills(merge = false): Promise<SkillListView> {
    const skills: SkillInfo[] = [];
    const layerDetail: SkillInfo[] = [];
    for (const name of this.layers.keys()) {
      const entries = this.sortedLayers(name);
      const winnerLayer = entries[0]![0];
      const enabled = !this.disabledNames.has(name);
      // 胜出项：shadowed 记录被它覆盖的低优先级层（与后端 loader 同构）
      const shadowed: SkillShadowedLayer[] = entries
        .slice(1)
        .map(([layer]) => ({ source: layer }));
      for (const [layer, skill] of entries) {
        const view: SkillInfo = {
          ...skill,
          enabled,
          editable: layer === "team",
          ...(layer === winnerLayer ? { shadowed } : { overriddenBy: winnerLayer }),
        };
        layerDetail.push(view);
        if (layer === winnerLayer) skills.push(view);
      }
    }
    if (!merge) {
      return {
        roots: { team: "(mock)", project: ["(mock)"] },
        skills: skills.filter((s) => s.source === "team"),
        layers: [],
        errors: [],
      };
    }
    return {
      roots: { team: "(mock)", project: ["(mock)"] },
      skills,
      layers: layerDetail,
      errors: [],
    };
  }

  async getSkill(name: string): Promise<SkillInfo> {
    const winner = this.winner(name);
    if (!winner) {
      throw new ApiError(`技能不存在: ${name}`, 404, "not_found");
    }
    return winner;
  }

  async createSkill(req: SkillEntryInput): Promise<SkillInfo> {
    if (this.layers.get(req.name)?.has("team")) {
      throw new ApiError(`团队技能已存在: ${req.name}`, 409, "conflict");
    }
    const byLayer = this.layers.get(req.name) ?? new Map<SkillSourceLayer, SkillInfo>();
    byLayer.set("team", {
      name: req.name,
      description: req.description,
      trigger: req.trigger,
      prompt: req.prompt,
      source: "team",
      enabled: true,
      editable: true,
      shadowed: [],
    });
    this.layers.set(req.name, byLayer);
    if (req.enabled === false) this.disabledNames.add(req.name);
    else this.disabledNames.delete(req.name);
    const created = this.winner(req.name)!;
    return created;
  }

  async updateSkill(name: string, patch: Partial<SkillEntryInput>): Promise<SkillInfo> {
    const byLayer = this.layers.get(name);
    if (!byLayer) {
      throw new ApiError(`技能不存在: ${name}`, 404, "not_found");
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
        editable: true,
        shadowed: [],
      };
      byLayer.set("team", {
        ...current,
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      });
    }
    const updated = this.winner(name);
    if (!updated) {
      throw new ApiError(`技能不存在: ${name}`, 404, "not_found");
    }
    return updated;
  }

  async deleteSkill(name: string): Promise<{ ok: boolean; name: string }> {
    const byLayer = this.layers.get(name);
    if (!byLayer) {
      throw new ApiError(`技能不存在: ${name}`, 404, "not_found");
    }
    if (!byLayer.has("team")) {
      const isBuiltin = byLayer.has("builtin");
      throw new ApiError(
        isBuiltin
          ? `「${name}」来自 builtin 层，不能删除；内置/本目录技能请用「恢复默认」或直接删除本目录文件`
          : `「${name}」来自 workdir 层，不能删除；内置/本目录技能请用「恢复默认」或直接删除本目录文件`,
        409,
        "not_editable",
      );
    }
    byLayer.delete("team");
    if (byLayer.size === 0) this.layers.delete(name);
    this.disabledNames.delete(name);
    return { ok: true, name };
  }

  async resetSkill(name: string): Promise<SkillInfo> {
    const byLayer = this.layers.get(name);
    if (!byLayer) {
      throw new ApiError(`技能不存在: ${name}`, 404, "not_found");
    }
    // 恢复默认 = 移除团队级覆盖 + 解除停用；workdir 下的本地文件不动
    byLayer.delete("team");
    this.disabledNames.delete(name);
    const restored = this.winner(name);
    if (!restored) {
      throw new ApiError(`「${name}」已无任何定义可恢复`, 404, "not_found");
    }
    return restored;
  }
}
