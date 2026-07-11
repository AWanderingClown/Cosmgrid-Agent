export type HarnessCandidateSurface =
  | "skill_instruction"
  | "tool_description"
  | "tool_result_format"
  | "context_selection"
  | "retry_policy"
  | "workflow_transition"
  | "model_profile"
  | "permission_policy"
  | "command_safety"
  | "keychain"
  | "eval_grader"
  | "held_out_data"
  | "audit_log"
  | "migration_runner"
  | "auto_activation";

export interface CandidateEditSummary {
  surface: HarnessCandidateSurface;
  diff: string;
}

export interface CandidateDecisionInput {
  heldInPassed: boolean;
  heldOutPassed: boolean;
  safetyPassed: boolean;
  approvedByUser: boolean;
}

export type CandidateDecision =
  | { status: "rejected"; reason: string }
  | { status: "pending_approval"; reason: string }
  | { status: "accepted"; reason: string };

const SAFE_SURFACES = new Set<HarnessCandidateSurface>([
  "skill_instruction",
  "tool_description",
  "tool_result_format",
  "context_selection",
  "retry_policy",
  "workflow_transition",
  "model_profile",
]);

export function canAutoApplyEditSurface(surface: HarnessCandidateSurface): boolean {
  return SAFE_SURFACES.has(surface);
}

export function deriveCandidateDecision(input: CandidateDecisionInput): CandidateDecision {
  if (!input.heldInPassed) return { status: "rejected", reason: "held-in failed" };
  if (!input.heldOutPassed) return { status: "rejected", reason: "held-out failed" };
  if (!input.safetyPassed) return { status: "rejected", reason: "safety failed" };
  if (!input.approvedByUser) return { status: "pending_approval", reason: "awaiting user approval" };
  return { status: "accepted", reason: "validated and approved" };
}

export function summarizeCandidateDiff(edits: CandidateEditSummary[]): string {
  const surfaces = [...new Set(edits.map((edit) => edit.surface))];
  return `${edits.length} edits: ${surfaces.join(", ")}`;
}
