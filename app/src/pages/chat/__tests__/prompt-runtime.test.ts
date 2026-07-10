import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareChatPromptRuntime } from "@/pages/chat/prompt-runtime";
import type { ChatMessage } from "@/pages/chat/types";

const mocks = vi.hoisted(() => ({
  buildChatPromptMessages: vi.fn(),
  applyPromptCompressionWithSummary: vi.fn(),
}));

vi.mock("@/pages/chat/prompt-messages", () => ({
  buildChatPromptMessages: mocks.buildChatPromptMessages,
}));

vi.mock("@/pages/chat/prompt-compression", () => ({
  applyPromptCompressionWithSummary: mocks.applyPromptCompressionWithSummary,
}));

describe("prepareChatPromptRuntime", () => {
  beforeEach(() => {
    mocks.buildChatPromptMessages.mockReset().mockReturnValue([
      { role: "system", content: "rules" },
      { role: "user", content: "hello" },
    ]);
    mocks.applyPromptCompressionWithSummary.mockReset().mockResolvedValue({
      messages: [{ role: "user", content: "compressed" }],
      compressionStats: { beforeTokens: 20, afterTokens: 10 },
    });
  });

  it("先组装 prompt，再按 smart 设置做摘要压缩", async () => {
    const messages: ChatMessage[] = [{ id: "user-1", role: "user", content: "hello" }];
    const summarizeModel = { modelId: "summary-model" } as never;

    const result = await prepareChatPromptRuntime({
      messages,
      effectiveWorkspace: "/tmp/project",
      primaryIsCli: false,
      projectMemoryPreamble: "project memory",
      crossProjectPreamble: "cross memory",
      workspacePreamble: "workspace",
      workflowPreamble: "workflow",
      skillPreamble: "skill",
      model: {
        id: "model-1",
        name: "gpt-test",
        displayName: "GPT Test",
        contextWindow: 128000,
      },
      smartRoutingEnabled: true,
      summarizeModel,
      conversationId: "conv-1",
      labels: {
        fileTooLarge: (name) => `too large ${name}`,
        contextTrimmed: (count) => `trimmed ${count}`,
      },
    });

    expect(mocks.buildChatPromptMessages).toHaveBeenCalledWith({
      messages,
      effectiveWorkspace: "/tmp/project",
      primaryIsCli: false,
      projectMemoryPreamble: "project memory",
      crossProjectPreamble: "cross memory",
      workspacePreamble: "workspace",
      workflowPreamble: "workflow",
      skillPreamble: "skill",
      tooLargeNotice: expect.any(Function),
      modelLabel: "GPT Test",
    });
    expect(mocks.applyPromptCompressionWithSummary).toHaveBeenCalledWith({
      enabled: true,
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "hello" },
      ],
      modelName: "gpt-test",
      contextWindow: 128000,
      noticeText: expect.any(Function),
      summarizeModel,
      persistence: {
        conversationId: "conv-1",
        modelId: "model-1",
        tokenCount: null,
      },
    });
    expect(result).toEqual({
      messages: [{ role: "user", content: "compressed" }],
      compressionStats: { beforeTokens: 20, afterTokens: 10 },
    });
  });

  it("没有会话时不传摘要落库配置", async () => {
    await prepareChatPromptRuntime({
      messages: [],
      effectiveWorkspace: null,
      primaryIsCli: true,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      workflowPreamble: null,
      skillPreamble: null,
      model: {
        id: "model-1",
        name: "gpt-test",
        displayName: null,
        contextWindow: null,
      },
      smartRoutingEnabled: false,
      summarizeModel: null,
      conversationId: null,
      labels: {
        fileTooLarge: (name) => `too large ${name}`,
        contextTrimmed: (count) => `trimmed ${count}`,
      },
    });

    expect(mocks.applyPromptCompressionWithSummary).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
      summarizeModel: undefined,
      persistence: undefined,
    }));
  });
});
