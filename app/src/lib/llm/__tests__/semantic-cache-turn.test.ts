import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnIntentDecision, WorkflowSnapshot } from "@/lib/workflow/types";
import { prepareSemanticCacheTurn } from "../semantic-cache-turn";

const mocks = vi.hoisted(() => ({
  classifyTurnIntentWithJudge: vi.fn(),
}));

vi.mock("@/lib/workflow/intent-judge", () => ({
  classifyTurnIntentWithJudge: mocks.classifyTurnIntentWithJudge,
}));

const answerOnlyDecision: TurnIntentDecision = {
  action: "answer_only",
  targetRunId: null,
  confidence: 1,
  reason: "test",
  evidenceTurnIds: [],
};

describe("prepareSemanticCacheTurn", () => {
  beforeEach(() => {
    mocks.classifyTurnIntentWithJudge.mockReset();
  });

  it("纯单模型模式不查语义缓存，但仍返回普通回答意图", async () => {
    const result = await prepareSemanticCacheTurn({
      text: "解释一下这个概念",
      pureMode: true,
      smartRoutingEnabled: true,
      workspacePath: null,
      workflowSnapshot: null,
      intentJudgeCalledThisTurn: false,
      turnIntentDecision: null,
      intentJudgeModel: null,
    });

    expect(result.cacheEligible).toBe(false);
    expect(result.cacheIntent.action).toBe("answer_only");
    expect(result.taskRole).toBe("standard");
    expect(mocks.classifyTurnIntentWithJudge).not.toHaveBeenCalled();
  });

  it("已有本轮意图裁判结果时复用它，不重复调用裁判模型", async () => {
    const result = await prepareSemanticCacheTurn({
      text: "什么意思",
      pureMode: false,
      smartRoutingEnabled: true,
      workspacePath: null,
      workflowSnapshot: null,
      intentJudgeCalledThisTurn: true,
      turnIntentDecision: answerOnlyDecision,
      intentJudgeModel: null,
    });

    expect(result.cacheEligible).toBe(true);
    expect(result.cacheIntent).toBe(answerOnlyDecision);
    expect(result.taskRole).toBe("simple");
    expect(mocks.classifyTurnIntentWithJudge).not.toHaveBeenCalled();
  });

  it("没有本轮意图裁判结果时，调用裁判后只允许普通回答命中缓存", async () => {
    const workflowSnapshot = { runId: "run-1" } as WorkflowSnapshot;
    mocks.classifyTurnIntentWithJudge.mockResolvedValue({
      action: "continue_run",
      targetRunId: "run-1",
      confidence: 0.9,
      reason: "continue",
      evidenceTurnIds: [],
    } satisfies TurnIntentDecision);

    const result = await prepareSemanticCacheTurn({
      text: "继续做",
      pureMode: false,
      smartRoutingEnabled: true,
      workspacePath: null,
      workflowSnapshot,
      intentJudgeCalledThisTurn: false,
      turnIntentDecision: null,
      intentJudgeModel: { modelId: "judge" } as never,
    });

    expect(result.cacheEligible).toBe(false);
    expect(result.cacheIntent.action).toBe("continue_run");
    expect(mocks.classifyTurnIntentWithJudge).toHaveBeenCalledWith({
      text: "继续做",
      activeRun: workflowSnapshot,
      model: { modelId: "judge" },
    });
  });

  it("有工作区时不查缓存，避免把项目相关回答复用到别处", async () => {
    const result = await prepareSemanticCacheTurn({
      text: "解释一下这个项目",
      pureMode: false,
      smartRoutingEnabled: true,
      workspacePath: "/tmp/project",
      workflowSnapshot: null,
      intentJudgeCalledThisTurn: true,
      turnIntentDecision: answerOnlyDecision,
      intentJudgeModel: null,
    });

    expect(result.cacheEligible).toBe(false);
  });
});
