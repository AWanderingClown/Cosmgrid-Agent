import type { WorkflowPhase } from "@/lib/workflow/types";
import type { AcceptanceCriterion } from "@/lib/llm/evidence/types";

export type SkillId = "project_audit" | "plan_execution" | "verification_closure";

/**
 * 阶段3（2026-07-11）：SkillDefinition.acceptanceCriteria 从 string[] 升级为
 * (string | StructuredAcceptanceCriterion)[] —— 老的 string 项仍接受（向后兼容
 * 不破坏 project_audit / plan_execution），verification_closure 在 registry.ts
 * 里改成结构化数组供 Task Verifier 跑。
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
}

export interface SelectedSkill {
  id: SkillId;
  label: string;
  selectedAt: string;
  reason: string;
}
