import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "../code-task-template";

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
}));

vi.mock("ai", () => ({
  generateObject: mocks.generateObject,
}));

const { classifyTurnIntentWithJudge } = await import("../intent-judge");

const model = { modelId: "judge-model" } as never;

const snapshot = () =>
  createCodeTaskWorkflowSnapshot({
    runId: "run-1",
    conversationId: "conv-1",
    objective: "做一份推广方案",
    workspacePath: "/tmp/project",
  });

describe("classifyTurnIntentWithJudge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("让另外一个 AI 评估一下 → review，不需要用户说固定关键词", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        action: "review",
        confidence: 0.88,
        reason: "用户要让另一个 AI 评估当前方案。",
      },
    });

    const decision = await classifyTurnIntentWithJudge({
      text: "好，那你让另外一个 AI 来评估一下这个方案",
      activeRun: snapshot(),
      model,
    });

    expect(decision.action).toBe("continue_run");
    expect(decision.patch?.reviewRequested).toBe(true);
    expect(decision.patch?.debateRequested).not.toBe(true);
  });

  it("多方互相反驳并裁判 → debate", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        action: "debate",
        confidence: 0.9,
        reason: "用户要求多方反驳和裁判。",
      },
    });

    const decision = await classifyTurnIntentWithJudge({
      text: "让几个模型分别站不同立场互相反驳，最后给一个裁判结论",
      activeRun: snapshot(),
      model,
    });

    expect(decision.action).toBe("continue_run");
    expect(decision.patch?.debateRequested).toBe(true);
  });

  it("低置信度或裁判失败时回退旧规则", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        action: "debate",
        confidence: 0.4,
        reason: "不确定。",
      },
    });

    const decision = await classifyTurnIntentWithJudge({
      text: "帮我比较方案后写成一篇软文",
      activeRun: snapshot(),
      model,
    });

    expect(decision.patch?.debateRequested).not.toBe(true);

    mocks.generateObject.mockRejectedValue(new Error("judge failed"));
    const fallback = await classifyTurnIntentWithJudge({
      text: "OK，直接执行这份方案",
      activeRun: snapshot(),
      model,
    });
    expect(fallback.action).toBe("approve_node");
  });

  it("passes semantic route examples into the judge prompt", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        action: "review",
        confidence: 0.86,
        reason: "语义样例也指向 review。",
      },
    });

    await classifyTurnIntentWithJudge({
      text: "找个审查者帮我看看这个方案有没有漏洞",
      activeRun: snapshot(),
      model,
    });

    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    expect(mocks.generateObject.mock.calls[0][0].prompt).toContain("语义样例路由");
    expect(mocks.generateObject.mock.calls[0][0].prompt).toContain("review");
  });

  it("uses high-confidence semantic routing when no judge model is available", async () => {
    const review = await classifyTurnIntentWithJudge({
      text: "你让另外一个 AI 来评估一下这个方案",
      activeRun: snapshot(),
      model: null,
    });

    expect(review.action).toBe("continue_run");
    expect(review.patch?.reviewRequested).toBe(true);
    expect(review.patch?.debateRequested).not.toBe(true);

    const debate = await classifyTurnIntentWithJudge({
      text: "让几个模型站不同立场互相反驳，最后给我裁判结论",
      activeRun: snapshot(),
      model: null,
    });

    expect(debate.action).toBe("continue_run");
    expect(debate.patch?.debateRequested).toBe(true);
  });

  it("uses learned examples as semantic routing evidence", async () => {
    const decision = await classifyTurnIntentWithJudge({
      text: "把这次误判记住：这个说法以后是评审，不是博弈",
      activeRun: snapshot(),
      model: null,
      learnedExamples: [
        {
          id: "learned-review-correction",
          action: "review",
          text: "把这次误判记住：这个说法以后是评审，不是博弈",
          explanation: "用户纠正过，这种表达应当进入评审。",
          source: "user_correction",
          weight: 1.4,
          enabled: true,
        },
      ],
    });

    expect(decision.action).toBe("continue_run");
    expect(decision.patch?.reviewRequested).toBe(true);
    expect(decision.patch?.debateRequested).not.toBe(true);
    expect(decision.reason).toContain("语义样例路由");
  });
});
