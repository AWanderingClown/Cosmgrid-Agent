import { describe, expect, it } from "vitest";
import { hasWorkflowIntent, shouldRunBackgroundOrchestration } from "../orchestration-gating";

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
});
