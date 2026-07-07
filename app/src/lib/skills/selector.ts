import type { WorkflowSnapshot } from "@/lib/workflow/types";
import { CORE_SKILLS } from "./registry";
import type { SelectedSkill, SkillDefinition } from "./types";

function normalize(text: string): string {
  return text.toLowerCase();
}

function currentPhase(snapshot: WorkflowSnapshot | null): string | null {
  if (!snapshot) return null;
  const node = snapshot.nodes.find((n) => n.id === snapshot.currentNodeId);
  return node?.phase ?? snapshot.currentNodeId;
}

function keywordHit(skill: SkillDefinition, text: string): boolean {
  const lower = normalize(text);
  return skill.triggerKeywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function selected(skill: SkillDefinition, reason: string): SelectedSkill {
  return {
    id: skill.id,
    label: skill.label,
    selectedAt: new Date().toISOString(),
    reason,
  };
}

export function selectSkillForTurn(args: {
  text: string;
  workflowSnapshot: WorkflowSnapshot | null;
}): SelectedSkill | null {
  const phase = currentPhase(args.workflowSnapshot);
  const verification = CORE_SKILLS.find((skill) => skill.id === "verification_closure")!;
  const execution = CORE_SKILLS.find((skill) => skill.id === "plan_execution")!;
  const audit = CORE_SKILLS.find((skill) => skill.id === "project_audit")!;

  if (phase === "verify" || keywordHit(verification, args.text)) {
    return selected(verification, phase === "verify" ? "workflow phase verify" : "verification keyword");
  }

  if (
    phase === "execute"
    || args.workflowSnapshot?.intent.executionMode === "execute_directly"
    || keywordHit(execution, args.text)
  ) {
    return selected(execution, phase === "execute" ? "workflow phase execute" : "execution keyword or mode");
  }

  if (phase === "read_project" || keywordHit(audit, args.text)) {
    return selected(audit, phase === "read_project" ? "workflow phase read_project" : "audit keyword");
  }

  return null;
}
