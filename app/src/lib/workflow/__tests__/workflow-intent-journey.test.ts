import { describe, expect, it } from "vitest";
import { classifyTurnIntentWithJudge } from "../intent-judge";
import { applyTurnIntentDecision } from "../reducer";
import { createCodeTaskWorkflowSnapshot } from "../code-task-template";

describe("workflow intent journey", () => {
  it("runs the real desired path without accidental debate", async () => {
    const first = await classifyTurnIntentWithJudge({
      text: "全面盘查一遍我们的项目，深入理解，等会儿我要写一篇公众号软文",
      activeRun: null,
      model: null,
    });

    expect(first.action).toBe("start_run");
    expect(first.patch?.debateRequested).not.toBe(true);
    expect(first.patch?.executionMode).toBe("plan_only");

    let snapshot = createCodeTaskWorkflowSnapshot({
      runId: "journey-run",
      conversationId: "journey-conv",
      objective: first.patch?.objective ?? "盘查项目并写软文",
      workspacePath: "/tmp/project",
      executionMode: first.patch?.executionMode,
    });

    const articleRevision = await classifyTurnIntentWithJudge({
      text: "你这文章推得也太硬了，我都没有想读的欲望，改得自然一点",
      activeRun: snapshot,
      model: null,
    });
    expect(articleRevision.action).toBe("answer_only");
    expect(articleRevision.patch?.debateRequested).not.toBe(true);

    const review = await classifyTurnIntentWithJudge({
      text: "好，那你让另外一个 AI 来评估一下这个方案",
      activeRun: snapshot,
      model: null,
    });
    expect(review.patch?.reviewRequested).toBe(true);
    expect(review.patch?.debateRequested).not.toBe(true);
    snapshot = applyTurnIntentDecision({ snapshot, decision: review });
    expect(snapshot.intent.reviewRequested).toBe(true);
    expect(snapshot.intent.debateRequested).toBe(false);

    const debate = await classifyTurnIntentWithJudge({
      text: "这次让几个模型互相反驳，最后裁判给结论",
      activeRun: snapshot,
      model: null,
    });
    expect(debate.patch?.debateRequested).toBe(true);
    snapshot = applyTurnIntentDecision({ snapshot, decision: debate });
    expect(snapshot.intent.debateRequested).toBe(true);

    const execute = await classifyTurnIntentWithJudge({
      text: "按这个方案开始改代码",
      activeRun: snapshot,
      model: null,
    });
    expect(execute.action).toBe("approve_node");
    expect(execute.patch?.executionMode).toBe("execute_directly");

    const verify = await classifyTurnIntentWithJudge({
      text: "跑一下测试看看有没有问题",
      activeRun: snapshot,
      model: null,
    });
    expect(verify.patch?.verificationRequired).toBe(true);
  });
});
