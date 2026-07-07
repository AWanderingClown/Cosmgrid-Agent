import type { WorkflowPhase } from "@/lib/workflow/types";

export type SkillId = "project_audit" | "plan_execution" | "verification_closure";

export interface SkillDefinition {
  id: SkillId;
  label: string;
  purpose: string;
  triggerPhases: WorkflowPhase[];
  triggerKeywords: string[];
  requiredCapabilities: string[];
  systemGuidance: string[];
  acceptanceCriteria: string[];
}

export interface SelectedSkill {
  id: SkillId;
  label: string;
  selectedAt: string;
  reason: string;
}
