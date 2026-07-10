import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPostStreamOrchestrationRuntime } from "@/pages/chat/post-stream-orchestration-runtime";

const mocks = vi.hoisted(() => ({
  shouldRunBackgroundOrchestration: vi.fn(),
  shouldAutoRunChain: vi.fn(),
  runBackgroundOrchestrationRuntime: vi.fn(),
  runChainExecutionRuntime: vi.fn(),
}));

vi.mock("@/lib/llm/orchestration-gating", () => ({
  shouldRunBackgroundOrchestration: mocks.shouldRunBackgroundOrchestration,
  shouldAutoRunChain: mocks.shouldAutoRunChain,
}));

vi.mock("@/pages/chat/background-orchestration-runtime", () => ({
  runBackgroundOrchestrationRuntime: mocks.runBackgroundOrchestrationRuntime,
}));

vi.mock("@/pages/chat/chain-execution-runtime", () => ({
  runChainExecutionRuntime: mocks.runChainExecutionRuntime,
}));

describe("runPostStreamOrchestrationRuntime", () => {
  beforeEach(() => {
    mocks.shouldRunBackgroundOrchestration.mockReset().mockReturnValue(true);
    mocks.shouldAutoRunChain.mockReset().mockReturnValue(true);
    mocks.runBackgroundOrchestrationRuntime.mockReset().mockImplementation(async (args) => {
      args.onChainPlan?.({ chain: ["reviewer"], roleBindings: new Map([["reviewer", "m1"]]) });
    });
    mocks.runChainExecutionRuntime.mockReset().mockResolvedValue(undefined);
  });

  it("满足后台编排门控时运行编排，并按链计划触发团队链", async () => {
    const controller = new AbortController();

    await runPostStreamOrchestrationRuntime({
      conversationId: "conv-1",
      activeConversationId: "conv-1",
      finalContent: "answer",
      finalAssistantMsg: { id: "a1", role: "assistant", content: "answer" },
      pureMode: false,
      controller,
      text: "继续",
      taskRole: "standard",
      hasWorkspace: true,
      intentDecision: { action: "answer_only", targetRunId: null, confidence: 1, reason: "x", evidenceTurnIds: [] },
      newMessages: [],
      orchestrationState: null,
      availableModels: [],
      credentials: [],
      getApiKey: vi.fn(),
      leaderModelId: "leader",
      applyOrchestration: vi.fn(),
      setSelectedModelId: vi.fn(),
      setMessages: vi.fn(),
      tools: { read: {} } as never,
      userTask: "继续",
      judgeModel: null,
      evalHarness: vi.fn(),
      applyToolExecutionRows: vi.fn(),
      chainAbortRef: { current: null },
      setChainExecutedRoles: vi.fn(),
      setChainSkippedRoles: vi.fn(),
      setChainAbortedRole: vi.fn(),
      setChainRunning: vi.fn(),
      t: vi.fn((key) => key) as never,
    });

    expect(mocks.runBackgroundOrchestrationRuntime).toHaveBeenCalled();
    expect(mocks.runChainExecutionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      chain: ["reviewer"],
      roleBindings: new Map([["reviewer", "m1"]]),
      conversationId: "conv-1",
    }));
  });

  it("纯模式或没有最终内容时不运行后台编排", async () => {
    await runPostStreamOrchestrationRuntime({
      conversationId: "conv-1",
      activeConversationId: "conv-1",
      finalContent: "",
      finalAssistantMsg: null,
      pureMode: true,
      controller: new AbortController(),
      text: "hello",
      taskRole: "standard",
      hasWorkspace: false,
      intentDecision: { action: "answer_only", targetRunId: null, confidence: 1, reason: "x", evidenceTurnIds: [] },
      newMessages: [],
      orchestrationState: null,
      availableModels: [],
      credentials: [],
      getApiKey: vi.fn(),
      leaderModelId: "leader",
      applyOrchestration: vi.fn(),
      setSelectedModelId: vi.fn(),
      setMessages: vi.fn(),
      tools: undefined,
      userTask: "hello",
      judgeModel: null,
      evalHarness: vi.fn(),
      applyToolExecutionRows: vi.fn(),
      chainAbortRef: { current: null },
      setChainExecutedRoles: vi.fn(),
      setChainSkippedRoles: vi.fn(),
      setChainAbortedRole: vi.fn(),
      setChainRunning: vi.fn(),
      t: vi.fn((key) => key) as never,
    });

    expect(mocks.runBackgroundOrchestrationRuntime).not.toHaveBeenCalled();
  });
});
