// skills/preamble 单测（task #11 补齐覆盖率）
// preamble.ts 当前 branches 0%；buildSkillPreamble 三个分支：skill=null / 找不到 definition / 命中。
import { describe, it, expect } from "vitest";
import { buildSkillPreamble } from "../preamble";
import type { SelectedSkill, SkillDefinition } from "../types";

describe("buildSkillPreamble", () => {
  it("skill 为 null 时返回 null", () => {
    expect(buildSkillPreamble(null)).toBeNull();
  });

  it("skill.id 在 registry 找不到对应定义时返回 null", () => {
    const fakeSkill = {
      // 强转绕过类型校验，确认运行时找不到定义时是 null 而不是抛错
      id: "nonexistent" as unknown as SelectedSkill["id"],
      label: "幽灵技能",
      selectedAt: "2026-07-10T00:00:00Z",
      reason: "test",
    };
    expect(buildSkillPreamble(fakeSkill)).toBeNull();
  });

  it("skill + 命中定义时返回完整 preamble（含标签/原因/目的/能力/规则/验收）", () => {
    const skill: SelectedSkill = {
      id: "project_audit",
      label: "",
      selectedAt: "2026-07-10T00:00:00Z",
      reason: "用户问「看看项目」",
    };
    const text = buildSkillPreamble(skill);
    expect(text).not.toBeNull();
    // 拼出来包含几个关键段落：当前启用技能 / 选择原因 / 目的 / 需要能力 / 执行规则 / 验收标准
    expect(text).toContain("当前启用技能：项目审计");
    expect(text).toContain("选择原因：用户问「看看项目」");
    expect(text).toContain("目的：");
    expect(text).toContain("需要能力：");
    expect(text).toContain("执行规则：");
    expect(text).toContain("验收标准：");
    // 真实定义里 systemGuidance 有「先读取项目文件」这类具体条目，至少出现一行 "- " 前缀
    expect(text).toMatch(/^- /m);
  });

  it("返回的多行 preamble 用 \\n 拼接，不是空字符串", () => {
    const skill: SelectedSkill = {
      id: "verification_closure",
      label: "",
      selectedAt: "2026-07-10T00:00:00Z",
      reason: "用户说「验证一下」",
    };
    const text = buildSkillPreamble(skill);
    expect(text).not.toBeNull();
    expect(text!.length).toBeGreaterThan(50);
    expect(text!.includes("\n")).toBe(true);
  });

  it("结构化验收标准渲染 description，不是 [object Object]", () => {
    // verification_closure 的 acceptanceCriteria 是 {id,description,kind} 对象数组，
    // 旧实现 `- ${item}` 会拼成 "- [object Object]"。
    const skill: SelectedSkill = {
      id: "verification_closure",
      label: "",
      selectedAt: "2026-07-10T00:00:00Z",
      reason: "验证",
    };
    const text = buildSkillPreamble(skill);
    expect(text).not.toBeNull();
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("运行测试套件全部通过");
  });

  it("skill.id 不在 CORE_SKILLS，但在传入的 definitions 里 → 用 definitions 解析（user skill 可渲染）", () => {
    const userSkill: SkillDefinition = {
      id: "custom_security_review",
      label: "安全审查",
      purpose: "对改动做 OWASP 视角复查。",
      triggerPhases: ["verify"],
      triggerKeywords: ["安全", "漏洞"],
      requiredCapabilities: ["read_files"],
      systemGuidance: ["先看认证与输入处理边界。"],
      acceptanceCriteria: ["列出高危项及修复建议。"],
      source: "user",
      reviewStatus: "approved",
    };
    const selected: SelectedSkill = {
      id: "custom_security_review",
      label: "安全审查",
      selectedAt: "2026-07-14T00:00:00Z",
      reason: "关键词命中：安全",
    };
    // 不传 definitions → CORE_SKILLS 找不到 → null（回归旧行为）
    expect(buildSkillPreamble(selected)).toBeNull();
    // 传 definitions → 命中，渲染完整 preamble
    const text = buildSkillPreamble(selected, [userSkill]);
    expect(text).not.toBeNull();
    expect(text).toContain("当前启用技能：安全审查");
    expect(text).toContain("先看认证与输入处理边界。");
    expect(text).toContain("列出高危项及修复建议。");
  });
});
