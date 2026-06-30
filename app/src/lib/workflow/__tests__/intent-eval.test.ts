import { describe, expect, it } from "vitest";
import { classifyTurnIntentWithJudge } from "../intent-judge";
import { createCodeTaskWorkflowSnapshot } from "../code-task-template";

const activeRun = () =>
  createCodeTaskWorkflowSnapshot({
    runId: "run-eval",
    conversationId: "conv-eval",
    objective: "完成一个项目工作流",
    workspacePath: "/tmp/project",
  });

describe("intent routing eval", () => {
  it.each([
    {
      text: "全面盘查一遍我们的项目，深入理解，等会儿我要写一篇公众号软文",
      active: null,
      expectedAction: "start_run",
      expectedPatch: "objective",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "好，那你让另外一个 AI 来评估一下这个方案",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "reviewRequested",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "让几个模型分别站不同立场互相反驳，最后给一个裁判结论",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "debateRequested",
      forbiddenPatch: "reviewRequested",
    },
    {
      text: "这篇软文推得太硬了，改得自然一点",
      active: activeRun(),
      expectedAction: "answer_only",
      expectedPatch: null,
      forbiddenPatch: "debateRequested",
    },
    {
      text: "按这个方案开始改代码",
      active: activeRun(),
      expectedAction: "approve_node",
      expectedPatch: "executionMode",
      forbiddenPatch: "debateRequested",
    },
    {
      text: "跑一下测试看看有没有问题",
      active: activeRun(),
      expectedAction: "continue_run",
      expectedPatch: "verificationRequired",
      forbiddenPatch: "debateRequested",
    },
  ])("$text", async ({ text, active, expectedAction, expectedPatch, forbiddenPatch }) => {
    const decision = await classifyTurnIntentWithJudge({
      text,
      activeRun: active,
      model: null,
    });

    expect(decision.action).toBe(expectedAction);
    if (expectedPatch) expect(decision.patch).toHaveProperty(expectedPatch);
    if (forbiddenPatch) expect(decision.patch?.[forbiddenPatch as keyof typeof decision.patch]).not.toBe(true);
  });
});
