import type { WorkflowPhase } from "@/lib/workflow/types";
import type { AcceptanceCriterion } from "@/lib/llm/evidence/types";

/**
 * Skill 标识（引擎化改造方案 §6 阶段 1b）。
 *
 * 原约束：`SkillId = "project_audit" | "plan_execution" | "verification_closure"`
 *  —— 闭合联合类型，写死在源码里。
 *
 * 新设计：放松为 `SkillId = string`，靠 DB `skill_definitions` 表 + 审核流程让用户/
 * 运营在不改源码的前提下加技能。
 *
 * 内置 3 个 id 通过 `BUILTIN_SKILL_IDS` 字面量子集保留——需要做穷举 switch 的调用点
 * 可继续 switch (skill.id) 配合 isBuiltinSkillId 守卫；不再"闭合"，但穷举性可校验。
 */
export type SkillId = string;

export const BUILTIN_SKILL_IDS = [
  "project_audit",
  "plan_execution",
  "verification_closure",
] as const;
export type BuiltinSkillId = (typeof BUILTIN_SKILL_IDS)[number];

export function isBuiltinSkillId(id: string): id is BuiltinSkillId {
  return (BUILTIN_SKILL_IDS as readonly string[]).includes(id);
}

/** Skill 注册来源。审核和数量上限的判定维度。 */
export type SkillSource = "builtin" | "user" | "ops";

/** 审核状态。approved = selector 装载；pending/rejected = 管理 UI 才看得见。 */
export type SkillReviewStatus = "approved" | "pending" | "rejected";

/**
 * SkillDefinition：闭合联合→ 引擎化字段补全。
 * 新增 source / reviewStatus；这两个字段在 builtin seed 时为 builtin/approved，
 * 在用户/运营注册时分别为 user/ops + pending。selector 只装 approved。
 */
export interface SkillDefinition {
  id: SkillId;
  label: string;
  purpose: string;
  triggerPhases: WorkflowPhase[];
  triggerKeywords: string[];
  requiredCapabilities: string[];
  systemGuidance: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  source: SkillSource;
  reviewStatus: SkillReviewStatus;
}

export interface SelectedSkill {
  id: SkillId;
  label: string;
  selectedAt: string;
  reason: string;
}
