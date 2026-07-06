import { describe, expect, it } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "../code-task-template";
import { applyTurnIntentDecision, completeCurrentWorkflowNode } from "../reducer";
import type { TurnIntentDecision } from "../types";

function snapshot() {
  return createCodeTaskWorkflowSnapshot({
    runId: "run-1",
    conversationId: "conv-1",
    objective: "完善项目",
    workspacePath: "/tmp/project",
  });
}

const decision = (partial: Partial<TurnIntentDecision>): TurnIntentDecision => ({
  action: "continue_run",
  targetRunId: "run-1",
  confidence: 0.9,
  reason: "test",
  evidenceTurnIds: [],
  ...partial,
});

describe("workflow reducer", () => {
  it("完成当前节点后进入 waiting_user 并生成下一步候选", () => {
    const next = completeCurrentWorkflowNode({ snapshot: snapshot(), summary: "项目摘要" });
    expect(next.status).toBe("waiting_user");
    expect(next.nodes.find((n) => n.id === "read_project")?.status).toBe("done");
    expect(next.nextActions.map((a) => a.id)).toEqual(["make_plan"]);
  });

  it("approve_node 进入 execute 节点", () => {
    const next = applyTurnIntentDecision({
      snapshot: snapshot(),
      decision: decision({ action: "approve_node", patch: { executionMode: "execute_directly" } }),
    });
    expect(next.status).toBe("running");
    expect(next.currentNodeId).toBe("execute");
    expect(next.nodes.find((n) => n.id === "execute")?.status).toBe("ready");
  });

  it("review/debate patch 分别进入对应可选节点", () => {
    expect(applyTurnIntentDecision({
      snapshot: snapshot(),
      decision: decision({ patch: { reviewRequested: true } }),
    }).currentNodeId).toBe("review");

    expect(applyTurnIntentDecision({
      snapshot: snapshot(),
      decision: decision({ patch: { debateRequested: true } }),
    }).currentNodeId).toBe("debate");
  });

  it("多个 nextActions 时 continue_run 停在 waiting_user 等用户选择", () => {
    const planned = {
      ...snapshot(),
      nextActions: [
        { id: "review", labelKey: "x", targetPhase: "review" as const, recommended: false, reason: "", risk: "low" as const, estimatedCost: "low" as const },
        { id: "execute", labelKey: "y", targetPhase: "execute" as const, recommended: true, reason: "", risk: "medium" as const, estimatedCost: "high" as const },
      ],
    };
    const next = applyTurnIntentDecision({ snapshot: planned, decision: decision({ action: "continue_run" }) });
    expect(next.status).toBe("waiting_user");
    expect(next.pendingDecision?.kind).toBe("pick_next_step");
  });
});
