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

/**
 * 按 phase 找一条 skill。引擎化阶段 1b：以前 selector 内部硬编 3 个 builtin id
 * (`find(s.id === "verification_closure")` 等)；现在用 phase 优先匹配 builtin，
 * 否则 user/ops（理论上 user skill 可注册同名 phase，但默认顺序先 builtin 更稳）。
 */
function findByPhase(allSkills: SkillDefinition[], phase: string): SkillDefinition | null {
  // 优先 builtin
  const builtin = allSkills.find(
    (s) => s.source === "builtin" && s.triggerPhases.includes(phase as SkillDefinition["triggerPhases"][number]),
  );
  if (builtin) return builtin;
  // 否则 user/ops（最早注册）
  return (
    allSkills.find((s) => s.triggerPhases.includes(phase as SkillDefinition["triggerPhases"][number])) ?? null
  );
}

export function selectSkillForTurn(args: {
  text: string;
  workflowSnapshot: WorkflowSnapshot | null;
  intentDecision?: TurnIntentDecision | null;
  semanticRoute?: SemanticIntentRoute | null;
  /** 阶段 1b：调用方传 DB 加载的 active 列表（approved 全集）。不传则降级到 CORE_SKILLS。 */
  activeSkills?: SkillDefinition[];
}): SelectedSkill | null {
  const skills = args.activeSkills ?? CORE_SKILLS;
  const phase = currentPhase(args.workflowSnapshot);
  const verification = findByPhase(skills, "verify");
  const execution = findByPhase(skills, "execute");
  const audit = findByPhase(skills, "read_project");
  const action = intentAction(args.intentDecision, args.semanticRoute);

  if (
    phase === "verify" || action === "verify"
    || (verification ? keywordHit(verification, args.text) : false)
  ) {
    if (!verification) return null;
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
    || (execution ? keywordHit(execution, args.text) : false)
  ) {
    if (!execution) return null;
    const reason = phase === "execute"
      ? "workflow phase execute"
      : action === "execute"
        ? "intent classifier execute"
        : "execution mode or keyword fallback";
    return selected(execution, reason);
  }

  if (
    phase === "read_project" || action === "start_run" || action === "plan"
    || (audit ? keywordHit(audit, args.text) : false)
  ) {
    if (!audit) return null;
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

