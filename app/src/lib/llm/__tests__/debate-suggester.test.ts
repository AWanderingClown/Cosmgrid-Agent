// debate-suggester 单测（增强-3：ChatPage 自动建议对弈）
import { describe, it, expect } from "vitest";
import { shouldSuggestDebate } from "../debate-suggester";

describe("shouldSuggestDebate — 只在开放式权衡问题上建议对弈", () => {
  it("技术选型 / 架构 / 对比类问题 → 建议", () => {
    expect(shouldSuggestDebate("我这个项目该用 Postgres 还是 MongoDB？")).toBe(true);
    expect(shouldSuggestDebate("帮我对比一下 Redux 和 Zustand 的优劣")).toBe(true);
    expect(shouldSuggestDebate("这个系统的架构该怎么设计")).toBe(true);
    expect(shouldSuggestDebate("Should I use REST or GraphQL for this API?")).toBe(true);
    expect(shouldSuggestDebate("微服务和单体哪个更好")).toBe(true);
  });

  it("有唯一正解的任务（调试/翻译/改名）→ 不建议", () => {
    expect(shouldSuggestDebate("这段代码为什么会崩，帮我排查")).toBe(false);
    expect(shouldSuggestDebate("把这段话翻译成英文")).toBe(false);
    expect(shouldSuggestDebate("帮我把这个函数重命名为 fetchUser")).toBe(false);
    expect(shouldSuggestDebate("格式化一下这个 JSON")).toBe(false);
  });

  it("太短的半句话不误触发", () => {
    expect(shouldSuggestDebate("要不要")).toBe(false);
    expect(shouldSuggestDebate("选型")).toBe(false);
  });

  it("空白 / 空串安全", () => {
    expect(shouldSuggestDebate("")).toBe(false);
    expect(shouldSuggestDebate("   ")).toBe(false);
  });

  it("寒暄 / 普通问答不触发", () => {
    expect(shouldSuggestDebate("你好，今天天气怎么样")).toBe(false);
    expect(shouldSuggestDebate("帮我写个 Hello World")).toBe(false);
  });
});
