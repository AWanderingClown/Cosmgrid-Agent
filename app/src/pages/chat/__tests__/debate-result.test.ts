import { describe, expect, it } from "vitest";
import { buildDebateTopic, formatDebateResultMessage, isFullDebateResult } from "@/lib/llm/debate-result";
import type { DebateResult } from "@/lib/llm/debate-engine";

const t = ((key: string, options?: { count?: number }) => {
  if (key === "chat.debate.singleModelNotice") return "单模型博弈已完成";
  if (key === "chat.debate.completed") return `${options?.count ?? 0} 个模型博弈已完成`;
  if (key === "chat.debate.incomplete") return "多模型博弈未完成，已用成功响应的模型生成降级方案。";
  if (key === "chat.debate.partialFailure") return `${options?.count ?? 0} 个模型调用失败，已跳过`;
  if (key === "chat.debate.skippedFailuresTitle") return "已跳过的失败调用";
  if (key === "chat.debate.skippedFailuresBody") return `${options?.count ?? 0} 个模型调用失败，聊天正文不展开`;
  return key;
}) as never;

const result: DebateResult = {
  topic: "要不要拆 ChatPage",
  finalSolution: "先低风险按职责拆。",
  rounds: [
    {
      role: "Solver",
      modelId: "model-a",
      content: "可以拆。",
      inputTokens: 10,
      outputTokens: 20,
    },
    {
      role: "Critic",
      modelId: "model-b",
      content: "不要顺手改行为。",
      inputTokens: 30,
      outputTokens: 40,
    },
  ],
};

const fullDebateResult: DebateResult = {
  ...result,
  rounds: [
    { role: "solver", modelId: "model-a", content: "可以拆。", inputTokens: 10, outputTokens: 20 },
    { role: "critic", modelId: "model-b", content: "不要顺手改行为。", inputTokens: 30, outputTokens: 40 },
    { role: "judge", modelId: "model-c", content: "最终裁决。", inputTokens: 50, outputTokens: 60 },
  ],
};

describe("formatDebateResultMessage", () => {
  it("distinguishes full debate from degraded solver-only output structurally", () => {
    expect(isFullDebateResult(fullDebateResult)).toBe(true);
    expect(isFullDebateResult({
      ...result,
      rounds: [
        { role: "solver", modelId: "model-a", content: "第一版方案", inputTokens: 1, outputTokens: 2 },
        { role: "solver", modelId: "model-b", content: "修正版方案", inputTokens: 3, outputTokens: 4 },
      ],
    })).toBe(false);
  });

  it("formats the debate answer and totals usage", () => {
    const formatted = formatDebateResultMessage({
      result: fullDebateResult,
      participantCount: 2,
      modelNameFor: (modelId) => ({ "model-a": "MiniMax", "model-b": "Kimi", "model-c": "Codex" })[modelId] ?? modelId,
      t,
    });

    expect(formatted.usage).toEqual({ inputTokens: 90, outputTokens: 120 });
    expect(formatted.content).toContain("2 个模型博弈已完成");
    // UI 修复（2026-07-02，用户反馈）：最终判断直接展示在正文里，不再用 "## 最终判断" 标题；
    // 博弈过程（各参与者完整输出）包进 <debate_process> 标签，parse-thinking.ts 识别后
    // 折叠渲染，不再平铺刷屏。
    expect(formatted.content).toContain("先低风险按职责拆。");
    expect(formatted.content).toContain("<debate_process>");
    expect(formatted.content).toContain("</debate_process>");
    expect(formatted.content).toContain("### 1. MiniMax · solver\n可以拆。");
    expect(formatted.content).toContain("### 2. Kimi · critic\n不要顺手改行为。");
    // 最终判断必须在 <debate_process> 标签之外（折叠块之前），不能被一起折叠掉
    expect(formatted.content.indexOf("先低风险按职责拆。")).toBeLessThan(
      formatted.content.indexOf("<debate_process>"),
    );
  });

  it("uses the single-model notice when only one participant is available", () => {
    const formatted = formatDebateResultMessage({
      result: { ...result, rounds: result.rounds.slice(0, 1) },
      participantCount: 1,
      modelNameFor: () => "MiniMax",
      t,
    });

    expect(formatted.content.startsWith("单模型博弈已完成")).toBe(true);
  });

  it("marks multi-model results without critic or judge as incomplete fallback", () => {
    const formatted = formatDebateResultMessage({
      result: {
        ...result,
        rounds: [
          { role: "solver", modelId: "model-a", content: "第一版方案", inputTokens: 1, outputTokens: 2 },
          { role: "solver", modelId: "model-b", content: "修正版方案", inputTokens: 3, outputTokens: 4 },
        ],
      },
      participantCount: 4,
      modelNameFor: (modelId) => modelId,
      t,
    });

    expect(formatted.content.startsWith("多模型博弈未完成，已用成功响应的模型生成降级方案。")).toBe(true);
    expect(formatted.content).not.toContain("4 个模型博弈已完成");
  });

  it("summarizes skipped model failures without dumping raw provider errors", () => {
    const formatted = formatDebateResultMessage({
      result: {
        ...result,
        failures: [
          "模型「MiniMax-M3」（solver）调用失败：SSE_CHUNK_TIMEOUT: 请求发出后 60000ms 内服务端没有任何响应",
        ],
      },
      participantCount: 2,
      modelNameFor: (modelId) => modelId,
      t,
    });

    expect(formatted.content).toContain("1 个模型调用失败，已跳过");
    expect(formatted.content).toContain("已跳过的失败调用");
    expect(formatted.content).not.toContain("SSE_CHUNK_TIMEOUT");
  });
});

describe("buildDebateTopic", () => {
  it("uses recent non-receipt turns and trims long content", () => {
    const topic = buildDebateTopic({
      maxHistoryMessages: 2,
      maxContentChars: 8,
      messages: [
        { id: "old", role: "user", content: "很旧的消息" },
        { id: "receipt", role: "assistant", content: "", kind: "receipt" },
        { id: "assistant", role: "assistant", content: "这是上一条 AI 回复，应该截断" },
      ],
      userMessage: { id: "user", role: "user", content: "请开始博弈" },
    });

    expect(topic).toBe("AI：这是上一条 AI\n\n用户：请开始博弈");
  });
});
