import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChainExecutionRuntime } from "@/pages/chat/chain-execution-runtime";

const mocks = vi.hoisted(() => ({
  buildApiModelEndpoints: vi.fn(),
  runChain: vi.fn(),
  startChainRun: vi.fn(),
  createChainRunCallbacks: vi.fn(),
  finishChainRun: vi.fn(),
}));

vi.mock("@/lib/llm/endpoint-list", () => ({
  buildApiModelEndpoints: mocks.buildApiModelEndpoints,
}));

vi.mock("@/lib/llm/chain-runner", () => ({
  runChain: mocks.runChain,
}));

vi.mock("@/pages/chat/chain-runtime", () => ({
  startChainRun: mocks.startChainRun,
  createChainRunCallbacks: mocks.createChainRunCallbacks,
  finishChainRun: mocks.finishChainRun,
}));

describe("runChainExecutionRuntime", () => {
  beforeEach(() => {
    mocks.buildApiModelEndpoints.mockReset().mockResolvedValue([{ modelId: "m1" }]);
    mocks.runChain.mockReset().mockResolvedValue({
      roleHarness: {},
      stoppedAt: null,
      skippedRoles: [],
    });
    mocks.startChainRun.mockReset();
    mocks.createChainRunCallbacks.mockReset().mockReturnValue({
      callbacks: {},
      chainPath: "leader -> reviewer",
      getCurrentMessageId: () => "msg-1",
    });
    mocks.finishChainRun.mockReset().mockResolvedValue(undefined);
  });

  it("没有链或已中止时直接跳过", async () => {
    const controller = new AbortController();
    controller.abort();

    await runChainExecutionRuntime({
      chain: ["reviewer" as never],
      roleBindings: new Map(),
      controller,
      tools: undefined,
      conversationId: "conv-1",
      userTask: "task",
      judgeModel: null,
      availableModels: [],
      credentials: [],
      getApiKey: vi.fn(),
      evalHarness: vi.fn(),
      applyToolExecutionRows: vi.fn(),
      chainAbortRef: { current: null },
      setMessages: vi.fn(),
      setChainExecutedRoles: vi.fn(),
      setChainSkippedRoles: vi.fn(),
      setChainAbortedRole: vi.fn(),
      setChainRunning: vi.fn(),
      t: vi.fn((key) => key) as never,
    });

    expect(mocks.buildApiModelEndpoints).not.toHaveBeenCalled();
  });

  it("构建 API endpoint 后执行团队链并完成 UI 收尾", async () => {
    const controller = new AbortController();
    const setChainRunning = vi.fn();
    const chainAbortRef = { current: null as AbortController | null };

    await runChainExecutionRuntime({
      chain: ["reviewer" as never],
      roleBindings: new Map([["reviewer" as never, "m1"]]),
      controller,
      tools: { read: {} } as never,
      conversationId: "conv-1",
      userTask: "review this",
      judgeModel: { modelId: "judge" } as never,
      availableModels: [{ id: "m1" }] as never,
      credentials: [{ id: "cred-1" }] as never,
      getApiKey: vi.fn(async () => "sk"),
      evalHarness: vi.fn(async () => null),
      applyToolExecutionRows: vi.fn(),
      chainAbortRef,
      setMessages: vi.fn(),
      setChainExecutedRoles: vi.fn(),
      setChainSkippedRoles: vi.fn(),
      setChainAbortedRole: vi.fn(),
      setChainRunning,
      t: vi.fn((key) => key) as never,
    });

    expect(mocks.buildApiModelEndpoints).toHaveBeenCalled();
    expect(mocks.startChainRun).toHaveBeenCalled();
    expect(mocks.runChain).toHaveBeenCalledWith(expect.objectContaining({
      chain: ["reviewer"],
      userTask: "review this",
      models: [{ modelId: "m1" }],
      tools: { read: {} },
      conversationId: "conv-1",
    }));
    expect(mocks.finishChainRun).toHaveBeenCalledWith(expect.objectContaining({
      chainPath: "leader -> reviewer",
      conversationId: "conv-1",
    }));
    expect(setChainRunning).toHaveBeenLastCalledWith(false);
    expect(chainAbortRef.current).toBeNull();
  });
});
