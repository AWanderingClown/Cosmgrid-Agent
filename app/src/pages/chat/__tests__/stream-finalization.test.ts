import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeStreamedChatTurn } from "@/pages/chat/stream-finalization";
import type { ChatMessage } from "@/pages/chat/types";

const mocks = vi.hoisted(() => ({
  writeCache: vi.fn(),
  saveSnapshot: vi.fn(),
  completeCurrentWorkflowNode: vi.fn(),
  failCurrentWorkflowNode: vi.fn(),
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
  failCurrentWorkflowNode: mocks.failCurrentWorkflowNode,
}));

function makeSnapshot(phase: string) {
  return {
    runId: "run-1",
    currentNodeId: "node-1",
    nodes: [{ id: "node-1", phase, status: "running" }],
  } as never;
}

describe("finalizeStreamedChatTurn", () => {
  beforeEach(() => {
    mocks.writeCache.mockReset();
    mocks.saveSnapshot.mockReset().mockResolvedValue(undefined);
    mocks.completeCurrentWorkflowNode.mockReset().mockReturnValue({ runId: "run-1", currentNodeId: null });
    mocks.failCurrentWorkflowNode.mockReset().mockReturnValue({ runId: "run-1", currentNodeId: "node-1" });
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
        harnessDirty: false,
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

  it("verifyNodeOutcome 判定 passed（plan 阶段不要求工具证据）时才完成工作流节点", async () => {
    const nextWorkflow = { runId: "run-1", currentNodeId: null };
    mocks.completeCurrentWorkflowNode.mockReturnValue(nextWorkflow);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("plan");

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
        harnessDirty: false,
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
    expect(mocks.failCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      snapshot: nextWorkflow,
      eventType: "workflow.node_completed",
    }));
    expect(applyWorkflowSnapshot).toHaveBeenCalledWith(nextWorkflow);
  });

  it("Harness 工程实施计划阶段1：execute 阶段 0 工具调用 → 验收不通过，不完成节点而是标 failed", async () => {
    const failedWorkflow = { runId: "run-1", currentNodeId: "node-1" };
    mocks.failCurrentWorkflowNode.mockReturnValue(failedWorkflow);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("execute");

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "我已经把文件改好了",
        lastModelId: "model-1",
        lastToolCallCount: 0,
        harnessDirty: false,
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

    expect(mocks.completeCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.failCurrentWorkflowNode).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: workflowSnapshot,
        outcome: expect.objectContaining({ status: "failed", failureCode: "no_tool_evidence" }),
      }),
    );
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      snapshot: failedWorkflow,
      eventType: "workflow.node_failed_verification",
    }));
    expect(applyWorkflowSnapshot).toHaveBeenCalledWith(failedWorkflow);
  });

  it("Harness 判定编造（harnessDirty=true）→ 即使有工具调用也不完成节点", async () => {
    const workflowSnapshot = makeSnapshot("execute");

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "final answer",
        lastModelId: "model-1",
        lastToolCallCount: 3,
        harnessDirty: true,
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
      applyWorkflowSnapshot: vi.fn(),
    });

    expect(mocks.completeCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.failCurrentWorkflowNode).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ failureCode: "harness_dirty" }) }),
    );
  });
});
