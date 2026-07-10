// skills/registry 单测（task #11 补齐覆盖率）
// registry.ts 当前 branches 0%；CORE_SKILLS 常量数据 + getSkillDefinition 两个分支。
import { describe, it, expect } from "vitest";
import { CORE_SKILLS, getSkillDefinition } from "../registry";

describe("CORE_SKILLS", () => {
  it("包含全部三个核心技能（project_audit / plan_execution / verification_closure）", () => {
    expect(CORE_SKILLS).toHaveLength(3);
    const ids = CORE_SKILLS.map((s) => s.id);
    expect(ids).toContain("project_audit");
    expect(ids).toContain("plan_execution");
    expect(ids).toContain("verification_closure");
  });

  it("每个技能都有非空必填字段（label / purpose / requiredCapabilities / triggerKeywords）", () => {
    for (const skill of CORE_SKILLS) {
      expect(skill.id).toBeTruthy();
      expect(skill.label).toBeTruthy();
      expect(skill.purpose).toBeTruthy();
      expect(skill.requiredCapabilities.length).toBeGreaterThan(0);
      expect(skill.triggerKeywords.length).toBeGreaterThan(0);
      expect(skill.systemGuidance.length).toBeGreaterThan(0);
      expect(skill.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(skill.triggerPhases.length).toBeGreaterThan(0);
    }
  });

  it("id 在三个核心技能中唯一", () => {
    const ids = CORE_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getSkillDefinition", () => {
  it("命中已知 id 时返回对应定义", () => {
    const def = getSkillDefinition("project_audit");
    expect(def).not.toBeNull();
    expect(def?.id).toBe("project_audit");
    expect(def?.label).toBe("项目审计");
  });

  it("未知 id 时返回 null 而不是抛错", () => {
    // 强转未知字符串绕过类型校验，验证运行时未命中分支
    expect(getSkillDefinition("nope" as never)).toBeNull();
    expect(getSkillDefinition(undefined as never)).toBeNull();
    expect(getSkillDefinition(null as never)).toBeNull();
  });

  it("每个核心 id 都能被 getSkillDefinition 找到", () => {
    for (const skill of CORE_SKILLS) {
      const def = getSkillDefinition(skill.id);
      expect(def?.id).toBe(skill.id);
    }
  });
});
