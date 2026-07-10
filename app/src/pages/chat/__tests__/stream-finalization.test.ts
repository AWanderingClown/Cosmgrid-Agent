import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeStreamedChatTurn } from "@/pages/chat/stream-finalization";
import type { ChatMessage } from "@/pages/chat/types";

const mocks = vi.hoisted(() => ({
  writeCache: vi.fn(),
  saveSnapshot: vi.fn(),
  completeCurrentWorkflowNode: vi.fn(),
}));

vi.mock("@/lib/llm/semantic-cache", () => ({
  writeCache: mocks.writeCache,
}));

vi.mock("@/lib/db", () => ({
  workflowRuns: {
    saveSnapshot: mocks.saveSnapshot,
  },
}));

vi.mock("@/lib/workflow/reducer", () => ({
  completeCurrentWorkflowNode: mocks.completeCurrentWorkflowNode,
}));

describe("finalizeStreamedChatTurn", () => {
  beforeEach(() => {
    mocks.writeCache.mockReset();
    mocks.saveSnapshot.mockReset().mockResolvedValue(undefined);
    mocks.completeCurrentWorkflowNode.mockReset().mockReturnValue({ runId: "run-1", currentNodeId: null });
  });

  it("更新工具调用数、持久化助手消息，并写入语义缓存", async () => {
    const setMessages = vi.fn((updater) => updater([{ id: "assistant-1", role: "assistant", content: "old" } as ChatMessage]));
    const persistAssistant = vi.fn();

    const result = await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "final answer",
        lastModelId: "model-1",
        lastResultModelId: "model-result",
        lastUsage: { inputTokens: 1, outputTokens: 2, toolCallCount: 1 },
        lastToolCallCount: 1,
      },
      conversationId: "conv-1",
      cacheEligible: true,
      taskRole: "standard",
      shouldCompleteWorkflowNode: false,
      workflowSnapshot: null,
      workflowRunId: null,
      controllerAborted: false,
      persistAssistant,
      setMessages,
      applyWorkflowSnapshot: vi.fn(),
    });

    expect(result.finalContent).toBe("final answer");
    expect(result.finalAssistantMsg).toMatchObject({ id: "assistant-1", content: "final answer" });
    expect(persistAssistant).toHaveBeenCalledWith(
      "final answer",
      "model-1",
      { inputTokens: 1, outputTokens: 2, toolCallCount: 1 },
      undefined,
      1,
    );
    expect(mocks.writeCache).toHaveBeenCalledWith("hello", "final answer", "model-result", "standard");
    expect(setMessages.mock.results[0]?.value[0]).toMatchObject({ toolCallCount: 1 });
  });

  it("需要完成工作流节点时保存新快照并应用到页面状态", async () => {
    const nextWorkflow = { runId: "run-1", currentNodeId: null };
    mocks.completeCurrentWorkflowNode.mockReturnValue(nextWorkflow);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = { runId: "run-1", currentNodeId: "node-1" } as never;

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "final answer",
        lastModelId: "model-1",
        lastResultModelId: "model-result",
        lastUsage: undefined,
        lastToolCallCount: 0,
      },
      conversationId: "conv-1",
      cacheEligible: false,
      taskRole: "standard",
      shouldCompleteWorkflowNode: true,
      workflowSnapshot,
      workflowRunId: "run-1",
      controllerAborted: false,
      persistAssistant: vi.fn(),
      setMessages: vi.fn((updater) => updater([])),
      applyWorkflowSnapshot,
    });

    expect(mocks.completeCurrentWorkflowNode).toHaveBeenCalledWith({
      snapshot: workflowSnapshot,
      summary: "final answer",
    });
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      snapshot: nextWorkflow,
      eventType: "workflow.node_completed",
    }));
    expect(applyWorkflowSnapshot).toHaveBeenCalledWith(nextWorkflow);
  });
});
