// Harness 工程实施计划 阶段4 — task_outcomes 上报。
//
// stream-finalization.ts 在 verifyNodeOutcome 派发后调 `reportTaskOutcome`，
// 把每个 node 的 5 种状态写到 task_outcomes 表。
// Eval Metrics（recovery_rate / human_interventions / context_continuity_rate）从这里聚合。

import { taskOutcomes, type TaskOutcomeValue } from "@/lib/db";

interface ReportArgs {
  conversationId: string;
  nodeId?: string;
  outcome: TaskOutcomeValue;
  finalSummary?: string;
  interventionKind?: string;
  evidenceRefsJson?: string;
}

/**
 * 上报 task_outcomes 失败静默：DB 写失败不影响主流程（节点完成事件已落地）。
 */
export async function reportTaskOutcome(args: ReportArgs): Promise<void> {
  try {
    await taskOutcomes.create({
      conversationId: args.conversationId,
      nodeId: args.nodeId ?? null,
      outcome: args.outcome,
      finalSummary: args.finalSummary ?? null,
      interventionKind: args.interventionKind ?? null,
      evidenceRefsJson: args.evidenceRefsJson ?? null,
    });
  } catch (err) {
    // 静默吞：eval 上报是"观测面"，不应阻塞节点完成主路径
    console.error("[evals] reportTaskOutcome 失败：", err);
  }
}

/** 5 种 NodeOutcome → 5 种 TaskOutcome 映射（用在 stream-finalization.ts） */
export function nodeOutcomeToTaskOutcome(
  nodeOutcomeStatus: "passed" | "failed" | "retryable" | "blocked" | "needs_user",
  interventionKind?: string,
): { outcome: TaskOutcomeValue; interventionKind: string | null } {
  switch (nodeOutcomeStatus) {
    case "passed":
      return { outcome: "passed", interventionKind: null };
    case "failed":
      return { outcome: "failed", interventionKind: interventionKind ?? null };
    case "retryable":
      return { outcome: "retryable", interventionKind: "auto_repair" };
    case "blocked":
      return { outcome: "blocked", interventionKind: "blocked_max_repair" };
    case "needs_user":
      return { outcome: "needs_user", interventionKind: "awaiting_user" };
  }
}