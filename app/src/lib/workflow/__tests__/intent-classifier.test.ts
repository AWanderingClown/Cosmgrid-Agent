import { describe, expect, it } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "../code-task-template";
import { classifyTurnIntent } from "../intent-classifier";
import { completeCurrentWorkflowNode } from "../reducer";

const snapshot = () =>
  createCodeTaskWorkflowSnapshot({
    runId: "run-1",
    conversationId: "conv-1",
    objective: "看一下项目",
    workspacePath: "/tmp/project",
  });

describe("classifyTurnIntent", () => {
  it("无 active run 时，看项目会开始新 workflow", () => {
    const decision = classifyTurnIntent({ text: "帮我看一下这个项目代码", activeRun: null });
    expect(decision.action).toBe("start_run");
    expect(decision.patch?.executionMode).toBe("plan_only");
    expect(decision.confidence).toBeGreaterThan(0.8);
  });

  it("已有 active run 时，做方案会继续当前 workflow", () => {
    const decision = classifyTurnIntent({ text: "做一份迭代方案", activeRun: snapshot() });
    expect(decision.action).toBe("continue_run");
    expect(decision.targetRunId).toBe("run-1");
    expect(decision.patch?.executionMode).toBe("plan_only");
  });

  it("直接执行会批准当前节点并设置 execute_directly", () => {
    const decision = classifyTurnIntent({ text: "OK，直接执行这份方案", activeRun: snapshot() });
    expect(decision.action).toBe("approve_node");
    expect(decision.patch?.executionMode).toBe("execute_directly");
  });

  it("要求评审和博弈会变成当前 workflow 的继续动作", () => {
    expect(classifyTurnIntent({ text: "让另一个模型评审一下", activeRun: snapshot() }).patch?.reviewRequested).toBe(true);
    expect(classifyTurnIntent({ text: "我们开多模型博弈比较方案", activeRun: snapshot() }).patch?.debateRequested).toBe(true);
  });

  it("分析项目并写推广软文不是博弈任务", () => {
    const decision = classifyTurnIntent({
      text: "全面盘查一遍我们的项目，深入理解，不要只读取 .md 文件，等会儿我要你写一篇公众号软文来推广",
      activeRun: snapshot(),
    });

    expect(decision.patch?.debateRequested).not.toBe(true);
  });

  it("反驳、比较方案这类普通描述不再自动升级成博弈", () => {
    expect(classifyTurnIntent({ text: "帮我比较方案后写成一篇软文", activeRun: snapshot() }).patch?.debateRequested).not.toBe(true);
    expect(classifyTurnIntent({ text: "文章里要提前反驳用户疑虑", activeRun: snapshot() }).patch?.debateRequested).not.toBe(true);
  });

  it("打回当前结果不会创建新 workflow", () => {
    const decision = classifyTurnIntent({ text: "不对，这个方案重来", activeRun: snapshot() });
    expect(decision.action).toBe("reject_node");
    expect(decision.targetRunId).toBe("run-1");
  });

  it("多个下一步时，继续保持较低置信度，让 UI 询问选择", () => {
    const ready = completeCurrentWorkflowNode({ snapshot: snapshot(), summary: "读完了" });
    const decision = classifyTurnIntent({ text: "继续吧", activeRun: ready });
    expect(decision.action).toBe("continue_run");
    expect(decision.confidence).toBeGreaterThan(0.75);
  });
});
