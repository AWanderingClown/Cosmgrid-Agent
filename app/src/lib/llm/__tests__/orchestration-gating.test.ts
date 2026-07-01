import { describe, expect, it } from "vitest";
import type { TurnIntentDecision } from "@/lib/workflow/types";
import { hasWorkflowIntent, shouldAutoRunChain, shouldRunBackgroundOrchestration } from "../orchestration-gating";

function decision(overrides: Partial<TurnIntentDecision>): TurnIntentDecision {
  return {
    action: "answer_only",
    targetRunId: null,
    confidence: 0.9,
    reason: "test",
    evidenceTurnIds: [],
    ...overrides,
  };
}

describe("orchestration-gating", () => {
  it("普通闲聊不触发后台编排", () => {
    expect(hasWorkflowIntent("你好")).toBe(false);
    expect(hasWorkflowIntent("你是什么模型")).toBe(false);
    expect(hasWorkflowIntent("？？")).toBe(false);
    expect(
      shouldRunBackgroundOrchestration({ text: "你好", taskRole: "simple", hasWorkspace: false, intentAction: "answer_only" }),
    ).toBe(false);
  });

  it("没有工作区时，普通任务不启动工作链路", () => {
    expect(
      shouldRunBackgroundOrchestration({
        text: "把这句话翻译成英文",
        taskRole: "simple",
        hasWorkspace: false,
        intentAction: "answer_only",
      }),
    ).toBe(false);
  });

  it("绑定工作区且有改代码意图时才触发", () => {
    expect(
      shouldRunBackgroundOrchestration({
        text: "帮我修复这个页面报错",
        taskRole: "standard",
        hasWorkspace: true,
        intentAction: "start_run",
      }),
    ).toBe(true);
    expect(
      shouldRunBackgroundOrchestration({
        text: "run tests and fix the bug",
        taskRole: "standard",
        hasWorkspace: true,
        intentAction: "continue_run",
      }),
    ).toBe(true);
  });

  it("纯讨论/为什么这样设计类问题，即使命中hard关键词、没绑工作区，也不触发编排（不该偷偷换模型）", () => {
    expect(
      shouldRunBackgroundOrchestration({
        text: "为什么这个架构要这样设计？",
        taskRole: "hard",
        hasWorkspace: false,
        intentAction: "answer_only",
      }),
    ).toBe(false);
  });

  it("想法讨论清楚、语义判断已收敛成具体任务时，即使暂未绑定工作区也允许编排介入", () => {
    expect(
      shouldRunBackgroundOrchestration({
        text: "好的，那就按这个方案开始建项目吧",
        taskRole: "hard",
        hasWorkspace: false,
        intentAction: "start_run",
      }),
    ).toBe(true);
  });

  it("只要方案时不立刻重复跑 architect 接力", () => {
    expect(shouldAutoRunChain({ text: "做一份更完整的计划方案", chain: ["architect"] })).toBe(false);
    expect(shouldAutoRunChain({ text: "给我一个项目路线图", chain: ["architect"] })).toBe(false);
  });

  it("评审方案和排下一步计划时，即使编排出了工程角色也不自动开工", () => {
    expect(
      shouldAutoRunChain({
        text: "我这边有一些问题，然后你看一下这个方案对不对？如果对，那我们按这个方案去做下一步的计划。",
        chain: ["frontend", "backend", "runner"],
        decision: decision({ action: "continue_run", patch: { executionMode: "plan_only" } }),
      }),
    ).toBe(false);
    expect(
      shouldAutoRunChain({
        text: "进优先级建议\nP1 拆分 ChatPage.tsx\nP2 bundle 拆分\n帮我看看这个方案对不对",
        chain: ["architect", "frontend", "backend"],
        decision: decision({ action: "continue_run", patch: { reviewRequested: true, executionMode: "plan_only" } }),
      }),
    ).toBe(false);
  });

  it("自动接力优先服从意图识别结果，而不是只看关键词", () => {
    expect(
      shouldAutoRunChain({
        text: "按这个方案去做下一步的计划",
        chain: ["frontend", "backend"],
        decision: decision({ action: "continue_run", patch: { executionMode: "plan_only" } }),
      }),
    ).toBe(false);

    expect(
      shouldAutoRunChain({
        text: "开始实现前端并跑测试",
        chain: ["frontend", "runner"],
        decision: decision({ action: "approve_node", patch: { executionMode: "execute_directly" } }),
      }),
    ).toBe(true);
  });

  it("执行类节点仍然自动接力", () => {
    expect(shouldAutoRunChain({ text: "根据方案开始实现前端", chain: ["frontend", "runner"] })).toBe(true);
    expect(shouldAutoRunChain({ text: "修复这个报错并跑测试", chain: ["backend", "runner", "tester"] })).toBe(true);
  });
});
