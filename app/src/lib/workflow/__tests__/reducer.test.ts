import { describe, expect, it } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "../code-task-template";
import { applyTurnIntentDecision, attachActiveSkillToWorkflow, completeCurrentWorkflowNode } from "../reducer";
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

  it("完成 plan 节点时把方案摘要和来源沉淀到 workflow context", () => {
    const ready = applyTurnIntentDecision({
      snapshot: completeCurrentWorkflowNode({ snapshot: snapshot(), summary: "项目摘要" }),
      decision: decision({ action: "continue_run" }),
    });
    const next = completeCurrentWorkflowNode({ snapshot: ready, summary: "Phase 1 先收口工作流" });

    expect(next.nodes.find((n) => n.id === "plan")?.status).toBe("done");
    expect(next.context.planSummary).toBe("Phase 1 先收口工作流");
    expect(next.context.planSource?.kind).toBe("message");
    expect(next.context.planSource?.ref).toBe("workflow:run-1:plan");
    expect(next.context.planSource?.summary).toBe("Phase 1 先收口工作流");
    expect(next.context.planSource?.phase).toBe("plan");
  });

  it("完成 debate 节点时把降级或完整方案作为后续执行来源", () => {
    const ready = applyTurnIntentDecision({
      snapshot: snapshot(),
      decision: decision({ patch: { debateRequested: true } }),
    });
    const next = completeCurrentWorkflowNode({
      snapshot: ready,
      summary: "降级方案正文",
      planSource: {
        kind: "degraded_debate",
        ref: "debate:session-1",
        summary: "降级方案正文",
        phase: "debate",
        boundAt: "2026-07-07T00:00:00.000Z",
        label: "多模型博弈未完成后的降级方案",
      },
    });

    expect(next.context.debateSummary).toBe("降级方案正文");
    expect(next.context.planSummary).toBe("降级方案正文");
    expect(next.context.planSource?.kind).toBe("degraded_debate");
    expect(next.context.planSource?.ref).toBe("debate:session-1");
  });

  it("可以把当前启用的 Skill 沉淀到 workflow context", () => {
    const next = attachActiveSkillToWorkflow({
      snapshot: snapshot(),
      skill: {
        id: "plan_execution",
        label: "按方案执行",
        selectedAt: "2026-07-07T00:00:00.000Z",
        reason: "execution mode execute_directly",
      },
    });

    expect(next.context.activeSkill).toMatchObject({
      id: "plan_execution",
      label: "按方案执行",
      reason: "execution mode execute_directly",
    });
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

  it("执行意图会清掉旧的 review/debate 请求，避免再次进入博弈", () => {
    const previous = {
      ...snapshot(),
      intent: {
        ...snapshot().intent,
        reviewRequested: true,
        debateRequested: true,
      },
    };
    const next = applyTurnIntentDecision({
      snapshot: previous,
      decision: decision({
        action: "approve_node",
        patch: { executionMode: "execute_directly", reviewRequested: false, debateRequested: false },
      }),
    });

    expect(next.currentNodeId).toBe("execute");
    expect(next.intent.reviewRequested).toBe(false);
    expect(next.intent.debateRequested).toBe(false);
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
