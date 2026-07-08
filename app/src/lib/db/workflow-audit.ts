// 把 WorkflowSnapshot + workflow_events 合并成一份可审计的状态摘要（L0 状态真相源）。
// 只做纯派生，不碰持久化——原本挂在 lib/workflow 下会导致 lib/db 反向依赖 lib/workflow
// 的运行时逻辑，这里只 type-only 引用 workflow 的类型（数据契约，不是逻辑耦合）。
import type { WorkflowPlanSourceKind, WorkflowRunStatus, WorkflowSnapshot } from "../workflow/types";

export interface WorkflowAuditEventLike {
  id: string;
  eventType: string;
  createdAt: string;
  payloadJson: string;
}

export interface WorkflowAuditTimelineEvent {
  id: string;
  eventType: string;
  createdAt: string;
  payload: unknown | null;
  payloadParseError: boolean;
}

export interface WorkflowAuditSummary {
  runId: string;
  conversationId: string;
  status: WorkflowRunStatus;
  currentPhase: string | null;
  objective: string;
  executionMode: string;
  planSourceKind: WorkflowPlanSourceKind | null;
  planSourcePath: string | null;
  planSourceLabel: string | null;
  activeSkillId: string | null;
  activeSkillLabel: string | null;
  degraded: boolean;
  latestEventType: string | null;
  eventCounts: Record<string, number>;
  timeline: WorkflowAuditTimelineEvent[];
}

function currentPhase(snapshot: WorkflowSnapshot): string | null {
  const node = snapshot.nodes.find((n) => n.id === snapshot.currentNodeId);
  return node?.phase ?? snapshot.currentNodeId;
}

function parsePayload(payloadJson: string): { payload: unknown | null; payloadParseError: boolean } {
  try {
    return { payload: JSON.parse(payloadJson) as unknown, payloadParseError: false };
  } catch {
    return { payload: null, payloadParseError: true };
  }
}

export function deriveWorkflowAuditSummary(args: {
  snapshot: WorkflowSnapshot;
  events: readonly WorkflowAuditEventLike[];
}): WorkflowAuditSummary {
  const timeline = args.events.map((event) => ({
    id: event.id,
    eventType: event.eventType,
    createdAt: event.createdAt,
    ...parsePayload(event.payloadJson),
  }));
  const eventCounts = timeline.reduce<Record<string, number>>((counts, event) => {
    counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
    return counts;
  }, {});
  const latestEvent = timeline.at(-1) ?? null;
  const planSource = args.snapshot.context.planSource ?? null;
  const activeSkill = args.snapshot.context.activeSkill ?? null;

  return {
    runId: args.snapshot.runId,
    conversationId: args.snapshot.conversationId,
    status: args.snapshot.status,
    currentPhase: currentPhase(args.snapshot),
    objective: args.snapshot.intent.objective,
    executionMode: args.snapshot.intent.executionMode,
    planSourceKind: planSource?.kind ?? null,
    planSourcePath: planSource?.kind === "file" ? planSource.ref : null,
    planSourceLabel: planSource?.label ?? null,
    activeSkillId: activeSkill?.id ?? null,
    activeSkillLabel: activeSkill?.label ?? null,
    degraded: planSource?.kind === "degraded_debate",
    latestEventType: latestEvent?.eventType ?? null,
    eventCounts,
    timeline,
  };
}
