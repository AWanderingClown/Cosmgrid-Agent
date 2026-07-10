import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBackgroundOrchestrationRuntime } from "@/pages/chat/background-orchestration-runtime";
import type { ChatMessage } from "@/pages/chat/types";

const mocks = vi.hoisted(() => ({
  planBackgroundOrchestration: vi.fn(),
  saveOrchestration: vi.fn(),
  buildOrchestrationReceipt: vi.fn(),
  appendOrchestrationReceiptMessage: vi.fn(),
}));

vi.mock("@/lib/llm/background-orchestration", () => ({
  planBackgroundOrchestration: mocks.planBackgroundOrchestration,
}));

vi.mock("@/lib/db", () => ({
  conversations: {
    saveOrchestration: mocks.saveOrchestration,
  },
}));

vi.mock("@/lib/llm/orchestrator", () => ({
  serializeOrchestration: vi.fn((state) => JSON.stringify(state)),
}));

vi.mock("@/pages/chat/orchestration-receipt", () => ({
  buildOrchestrationReceipt: mocks.buildOrchestrationReceipt,
  appendOrchestrationReceiptMessage: mocks.appendOrchestrationReceiptMessage,
}));

describe("runBackgroundOrchestrationRuntime", () => {
  beforeEach(() => {
    mocks.planBackgroundOrchestration.mockReset().mockResolvedValue({
      next: { id: "next" },
      nextWithChain: { id: "next-chain" },
      change: { nodeChanged: true, modelChanged: true, node: { role: "reviewer", modelId: "m2" } },
      reason: "reason",
      chainPlan: ["reviewer"],
      effectiveChainBindings: new Map([["reviewer", "m2"]]),
    });
    mocks.saveOrchestration.mockReset().mockResolvedValue(undefined);
    mocks.buildOrchestrationReceipt.mockReset().mockReturnValue({ summary: "receipt", detail: "detail" });
    mocks.appendOrchestrationReceiptMessage.mockReset().mockResolvedValue(undefined);
  });

  it("规划后台编排、保存状态、应用到当前会话并回调链计划", async () => {
    const onChainPlan = vi.fn();
    const applyOrchestration = vi.fn();
    const setSelectedModelId = vi.fn();
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hello" },
      { id: "r1", role: "assistant", content: "", kind: "receipt" },
    ];

    await runBackgroundOrchestrationRuntime({
      conversationId: "conv-1",
      activeConversationId: "conv-1",
      messages,
      previousState: null,
      availableModels: [{ id: "m2" }] as never,
      credentials: [],
      getApiKey: vi.fn(),
      leaderModelId: "leader",
      applyOrchestration,
      setSelectedModelId,
      setMessages: vi.fn(),
      onChainPlan,
      t: vi.fn((key) => key) as never,
    });

    expect(mocks.planBackgroundOrchestration).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      history: [{ role: "user", content: "hello" }],
    }));
    expect(onChainPlan).toHaveBeenCalledWith({
      chain: ["reviewer"],
      roleBindings: new Map([["reviewer", "m2"]]),
    });
    expect(mocks.saveOrchestration).toHaveBeenCalledWith("conv-1", JSON.stringify({ id: "next-chain" }));
    expect(applyOrchestration).toHaveBeenCalledWith({ id: "next-chain" });
    expect(setSelectedModelId).toHaveBeenCalledWith("m2");
    expect(mocks.appendOrchestrationReceiptMessage).toHaveBeenCalled();
  });

  it("不是当前会话时只保存，不更新页面 UI", async () => {
    const applyOrchestration = vi.fn();

    await runBackgroundOrchestrationRuntime({
      conversationId: "conv-1",
      activeConversationId: "conv-other",
      messages: [],
      previousState: null,
      availableModels: [{ id: "m2" }] as never,
      credentials: [],
      getApiKey: vi.fn(),
      leaderModelId: "leader",
      applyOrchestration,
      setSelectedModelId: vi.fn(),
      setMessages: vi.fn(),
      t: vi.fn((key) => key) as never,
    });

    expect(mocks.saveOrchestration).toHaveBeenCalled();
    expect(applyOrchestration).not.toHaveBeenCalled();
  });
});
