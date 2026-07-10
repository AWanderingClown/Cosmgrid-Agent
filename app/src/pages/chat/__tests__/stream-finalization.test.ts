import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeStreamedChatTurn } from "@/pages/chat/stream-finalization";
import type { ChatMessage } from "@/pages/chat/types";

const mocks = vi.hoisted(() => ({
  writeCache: vi.fn(),
  saveSnapshot: vi.fn(),
  listByMessage: vi.fn(),
  completeCurrentWorkflowNode: vi.fn(),
  failCurrentWorkflowNode: vi.fn(),
  repairCurrentWorkflowNode: vi.fn(),
}));

vi.mock("@/lib/llm/semantic-cache", () => ({
  writeCache: mocks.writeCache,
}));

vi.mock("@/lib/db", () => ({
  workflowRuns: {
    saveSnapshot: mocks.saveSnapshot,
  },
  toolExecutions: {
    listByMessage: mocks.listByMessage,
  },
}));

vi.mock("@/lib/workflow/reducer", () => ({
  completeCurrentWorkflowNode: mocks.completeCurrentWorkflowNode,
  failCurrentWorkflowNode: mocks.failCurrentWorkflowNode,
  repairCurrentWorkflowNode: mocks.repairCurrentWorkflowNode,
}));

function makeSnapshot(phase: string, overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    currentNodeId: "node-1",
    nodes: [{ id: "node-1", phase, status: "running", ...overrides }],
  } as never;
}

describe("finalizeStreamedChatTurn", () => {
  beforeEach(() => {
    mocks.writeCache.mockReset();
    mocks.saveSnapshot.mockReset().mockResolvedValue(undefined);
    mocks.listByMessage.mockReset().mockResolvedValue([]);
    mocks.completeCurrentWorkflowNode.mockReset().mockReturnValue({ runId: "run-1", currentNodeId: null });
    mocks.failCurrentWorkflowNode.mockReset().mockReturnValue({ runId: "run-1", currentNodeId: "node-1" });
    mocks.repairCurrentWorkflowNode.mockReset().mockReturnValue({ runId: "run-1", currentNodeId: "execute" });
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

  it("Harness 工程实施计划阶段1：verify 阶段 0 工具证据 + 未达修复上限 → retryable，打回 execute 而不是锁死失败", async () => {
    const repairedWorkflow = { runId: "run-1", currentNodeId: "execute" };
    mocks.repairCurrentWorkflowNode.mockReturnValue(repairedWorkflow);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("verify", { repairAttempts: 0 });

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "测试跑完了",
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
    expect(mocks.failCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.repairCurrentWorkflowNode).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: workflowSnapshot,
        outcome: expect.objectContaining({ status: "retryable", failureCode: "no_tool_evidence" }),
      }),
    );
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      snapshot: repairedWorkflow,
      eventType: "workflow.node_repair_retry",
    }));
    expect(applyWorkflowSnapshot).toHaveBeenCalledWith(repairedWorkflow);
  });

  it("Harness 工程实施计划阶段1：verify 已修复到上限（repairAttempts=2）→ blocked，锁死等人工介入", async () => {
    const blockedWorkflow = { runId: "run-1", currentNodeId: "node-1" };
    mocks.failCurrentWorkflowNode.mockReturnValue(blockedWorkflow);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("verify", { repairAttempts: 2 });

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "又跑了一次",
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

    expect(mocks.repairCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.failCurrentWorkflowNode).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ status: "blocked" }) }),
    );
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      snapshot: blockedWorkflow,
      eventType: "workflow.node_blocked",
    }));
    expect(applyWorkflowSnapshot).toHaveBeenCalledWith(blockedWorkflow);
  });

  it("Harness 工程实施计划阶段1：本轮有工具被用户拒绝（denied）→ needs_user，节点原样不动", async () => {
    mocks.listByMessage.mockResolvedValue([{ id: "te-1", status: "denied" }]);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("execute");

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "我需要写文件但你拒绝了",
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

    expect(mocks.listByMessage).toHaveBeenCalledWith("assistant-1");
    expect(mocks.completeCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.failCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.repairCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.saveSnapshot).not.toHaveBeenCalled();
    expect(applyWorkflowSnapshot).not.toHaveBeenCalled();
  });
});
