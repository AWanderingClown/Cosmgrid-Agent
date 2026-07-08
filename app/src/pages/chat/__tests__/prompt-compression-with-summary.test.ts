import { describe, expect, it, vi } from "vitest";

const { generateObjectMock, conversationSummariesCreateMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  conversationSummariesCreateMock: vi.fn(),
}));

vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    conversationSummaries: {
      create: conversationSummariesCreateMock,
      listRecentByConversation: vi.fn(async () => []),
    },
  };
});

import { applyPromptCompressionWithSummary } from "../prompt-compression";
import type { LanguageModel } from "@/lib/llm/provider-factory";
import type { ChatMsg } from "@/lib/llm/context-compressor";

const fakeModel = { modelId: "summarizer-model" } as LanguageModel;

const longMessages: ChatMsg[] = [
  { role: "system", content: "规则" },
  { role: "user", content: "第一轮问题 ".repeat(3000) },
  { role: "assistant", content: "第一轮回答 ".repeat(3000) },
  { role: "user", content: "第二轮问题 ".repeat(3000) },
  { role: "assistant", content: "第二轮回答 ".repeat(3000) },
  { role: "user", content: "第三轮问题 ".repeat(3000) },
  { role: "assistant", content: "第三轮回答 ".repeat(3000) },
];

const fakeSummary = {
  summary: "用户做登录表单，定了 react-hook-form",
  keyDecisions: ["用 react-hook-form"],
  factsEstablished: ["登录接口未联调"],
  openThreads: ["后端对接"],
};

describe("applyPromptCompressionWithSummary", () => {
  it("disabled 时原样返回，不调 LLM 不写库", async () => {
    generateObjectMock.mockReset();
    conversationSummariesCreateMock.mockReset();

    const result = await applyPromptCompressionWithSummary({
      enabled: false,
      messages: longMessages,
      modelName: "test",
      contextWindow: 100,
      noticeText: (n) => `[${n}]`,
      summarizeModel: fakeModel,
      persistence: { conversationId: "conv-1", modelId: "test" },
    });

    expect(result.messages).toBe(longMessages);
    expect(result.compressionStats).toBeNull();
    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(conversationSummariesCreateMock).not.toHaveBeenCalled();
  });

  it("未传 summarizeModel 时退回同步抽取式（直接复用旧实现），不调 LLM 不写库", async () => {
    generateObjectMock.mockReset();
    conversationSummariesCreateMock.mockReset();

    const result = await applyPromptCompressionWithSummary({
      enabled: true,
      messages: longMessages,
      modelName: "test",
      contextWindow: null,
      noticeText: (n) => `[${n}]`,
      // summarizeModel: undefined
    });

    expect(result.messages.length).toBeLessThan(longMessages.length + 1);
    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(conversationSummariesCreateMock).not.toHaveBeenCalled();
  });

  it("传了 summarizeModel 且真的丢消息时调 LLM 摘要并写库", async () => {
    generateObjectMock.mockReset().mockResolvedValue({ object: fakeSummary });
    conversationSummariesCreateMock.mockReset().mockResolvedValue({
      id: "sum-1",
      conversationId: "conv-1",
      ...fakeSummary,
      modelId: "summarizer-model",
      tokenCount: null,
      createdAt: new Date().toISOString(),
    });

    const result = await applyPromptCompressionWithSummary({
      enabled: true,
      messages: longMessages,
      modelName: "test",
      contextWindow: null,
      noticeText: (n) => `[${n}]`,
      summarizeModel: fakeModel,
      persistence: { conversationId: "conv-1", modelId: "summarizer-model" },
    });

    // LLM 被调
    expect(generateObjectMock).toHaveBeenCalledTimes(1);

    // 落库（fire-and-forget，等一个 microtask 让 promise resolve）
    await new Promise((r) => setTimeout(r, 0));
    expect(conversationSummariesCreateMock).toHaveBeenCalledTimes(1);
    const callArgs = conversationSummariesCreateMock.mock.calls[0]![0] as {
      conversationId: string;
      summary: string;
      keyDecisions: string[];
      factsEstablished: string[];
      openThreads: string[];
      modelId: string | null;
    };
    expect(callArgs.conversationId).toBe("conv-1");
    expect(callArgs.summary).toBe(fakeSummary.summary);
    expect(callArgs.keyDecisions).toEqual(fakeSummary.keyDecisions);
    expect(callArgs.factsEstablished).toEqual(fakeSummary.factsEstablished);
    expect(callArgs.openThreads).toEqual(fakeSummary.openThreads);
    expect(callArgs.modelId).toBe("summarizer-model");

    // 输出里包含摘要文本
    const summaryInOutput = result.messages.find(
      (m) => m.role === "system" && String(m.content).includes("Earlier conversation summary"),
    );
    expect(summaryInOutput).toBeDefined();
  });

  it("未传 persistence 时调 LLM 但不写库", async () => {
    generateObjectMock.mockReset().mockResolvedValue({ object: fakeSummary });
    conversationSummariesCreateMock.mockReset();

    await applyPromptCompressionWithSummary({
      enabled: true,
      messages: longMessages,
      modelName: "test",
      contextWindow: null,
      noticeText: (n) => `[${n}]`,
      summarizeModel: fakeModel,
      // persistence: undefined
    });

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(conversationSummariesCreateMock).not.toHaveBeenCalled();
  });

  it("precheck 返回 false 时不调 LLM，直接走 notice", async () => {
    generateObjectMock.mockReset();
    conversationSummariesCreateMock.mockReset();

    const result = await applyPromptCompressionWithSummary({
      enabled: true,
      messages: longMessages,
      modelName: "test",
      contextWindow: null,
      noticeText: (n) => `[precheck-blocked ${n}]`,
      summarizeModel: fakeModel,
      precheck: () => false,
      persistence: { conversationId: "conv-1" },
    });

    expect(generateObjectMock).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(conversationSummariesCreateMock).not.toHaveBeenCalled();
    const summaryInOutput = result.messages.find(
      (m) => m.role === "system" && String(m.content).includes("precheck-blocked"),
    );
    expect(summaryInOutput).toBeDefined();
  });

  it("落库抛错时主流程不阻断（fire-and-forget）", async () => {
    generateObjectMock.mockReset().mockResolvedValue({ object: fakeSummary });
    conversationSummariesCreateMock.mockReset().mockRejectedValue(new Error("db write fail"));

    // 不应抛错——主流程必须完成
    const result = await applyPromptCompressionWithSummary({
      enabled: true,
      messages: longMessages,
      modelName: "test",
      contextWindow: null,
      noticeText: (n) => `[${n}]`,
      summarizeModel: fakeModel,
      persistence: { conversationId: "conv-1" },
    });

    // 主流程返回正常结构
    expect(result.compressionStats).not.toBeNull();
    expect(result.messages.length).toBeLessThan(longMessages.length + 1);
    // 让 fire-and-forget 的 reject 走完
    await new Promise((r) => setTimeout(r, 0));
  });
});