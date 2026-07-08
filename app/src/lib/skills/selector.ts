import type { IntentRouteAction, SemanticIntentRoute } from "@/lib/workflow/semantic-intent-router";
import type { TurnIntentDecision, WorkflowSnapshot } from "@/lib/workflow/types";
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
  intentDecision?: TurnIntentDecision | null;
  semanticRoute?: SemanticIntentRoute | null;
}): SelectedSkill | null {
  const phase = currentPhase(args.workflowSnapshot);
  const verification = CORE_SKILLS.find((skill) => skill.id === "verification_closure")!;
  const execution = CORE_SKILLS.find((skill) => skill.id === "plan_execution")!;
  const audit = CORE_SKILLS.find((skill) => skill.id === "project_audit")!;
  const action = intentAction(args.intentDecision, args.semanticRoute);

  if (phase === "verify" || action === "verify" || keywordHit(verification, args.text)) {
    const reason = phase === "verify"
      ? "workflow phase verify"
      : action === "verify"
        ? "intent classifier verify"
        : "keyword fallback: verification";
    return selected(verification, reason);
  }

  if (
    phase === "execute"
    || args.workflowSnapshot?.intent.executionMode === "execute_directly"
    || action === "execute"
    || keywordHit(execution, args.text)
  ) {
    const reason = phase === "execute"
      ? "workflow phase execute"
      : action === "execute"
        ? "intent classifier execute"
        : "execution mode or keyword fallback";
    return selected(execution, reason);
  }

  if (phase === "read_project" || action === "start_run" || action === "plan" || keywordHit(audit, args.text)) {
    const reason = phase === "read_project"
      ? "workflow phase read_project"
      : action
        ? `intent classifier ${action}`
        : "keyword fallback: audit";
    return selected(audit, reason);
  }

  return null;
}

function intentAction(
  decision: TurnIntentDecision | null | undefined,
  semanticRoute: SemanticIntentRoute | null | undefined,
): IntentRouteAction | null {
  if (decision?.patch?.verificationRequired || (decision?.action === "continue_run" && /verify/i.test(decision.reason))) return "verify";
  if (decision?.patch?.executionMode === "execute_directly" || decision?.action === "approve_node") return "execute";
  if (decision?.action === "start_run") return "start_run";
  if (decision?.patch?.executionMode === "plan_only") return "plan";
  if (semanticRoute && !semanticRoute.noMatch && semanticRoute.confidence >= 0.64) {
    return semanticRoute.top?.action ?? null;
  }
  return null;
}
