import { describe, expect, it } from "vitest";
import { hasWorkflowIntent, shouldAutoRunChain, shouldRunBackgroundOrchestration } from "../orchestration-gating";

describe("orchestration-gating", () => {
  it("普通闲聊不触发后台编排", () => {
    expect(hasWorkflowIntent("你好")).toBe(false);
    expect(hasWorkflowIntent("你是什么模型")).toBe(false);
    expect(hasWorkflowIntent("？？")).toBe(false);
    expect(shouldRunBackgroundOrchestration({ text: "你好", taskRole: "simple", hasWorkspace: false })).toBe(false);
  });

  it("没有工作区时，普通任务不启动工作链路", () => {
    expect(shouldRunBackgroundOrchestration({ text: "把这句话翻译成英文", taskRole: "simple", hasWorkspace: false })).toBe(false);
  });

  it("绑定工作区且有改代码意图时才触发", () => {
    expect(shouldRunBackgroundOrchestration({ text: "帮我修复这个页面报错", taskRole: "standard", hasWorkspace: true })).toBe(true);
    expect(shouldRunBackgroundOrchestration({ text: "run tests and fix the bug", taskRole: "standard", hasWorkspace: true })).toBe(true);
  });

  it("复杂任务即使暂未绑定工作区也允许编排建议", () => {
    expect(shouldRunBackgroundOrchestration({ text: "帮我设计这个系统架构", taskRole: "hard", hasWorkspace: false })).toBe(true);
  });

  it("只要方案时不立刻重复跑 architect 接力", () => {
    expect(shouldAutoRunChain({ text: "做一份更完整的计划方案", chain: ["architect"] })).toBe(false);
    expect(shouldAutoRunChain({ text: "给我一个项目路线图", chain: ["architect"] })).toBe(false);
  });

  it("执行类节点仍然自动接力", () => {
    expect(shouldAutoRunChain({ text: "根据方案开始实现前端", chain: ["frontend", "runner"] })).toBe(true);
    expect(shouldAutoRunChain({ text: "修复这个报错并跑测试", chain: ["backend", "runner", "tester"] })).toBe(true);
  });
});
