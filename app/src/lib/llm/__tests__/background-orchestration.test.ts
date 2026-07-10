import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAuxiliaryModel: vi.fn(),
  planNodes: vi.fn(),
  getRoleBindingsForConversation: vi.fn(),
  usageEventsList: vi.fn(),
  buildRolePerformanceScoresFromUsageRows: vi.fn(),
  resolveOrchestration: vi.fn(),
  computeChain: vi.fn(),
  withChainPlan: vi.fn(),
  shouldSkipOrchestrationUpdate: vi.fn(),
  diffOrchestration: vi.fn(),
}));

vi.mock("../auxiliary-model", () => ({
  resolveAuxiliaryModel: mocks.resolveAuxiliaryModel,
}));

vi.mock("@/lib/db", () => ({
  getRoleBindingsForConversation: mocks.getRoleBindingsForConversation,
  usageEvents: {
    list: mocks.usageEventsList,
  },
}));

vi.mock("../model-performance-scoring", () => ({
  buildRolePerformanceScoresFromUsageRows: mocks.buildRolePerformanceScoresFromUsageRows,
}));

vi.mock("../orchestrator", async () => {
  const actual = await vi.importActual<typeof import("../orchestrator")>("../orchestrator");
  return {
    ...actual,
    planNodes: mocks.planNodes,
    resolveOrchestration: mocks.resolveOrchestration,
    computeChain: mocks.computeChain,
    withChainPlan: mocks.withChainPlan,
    shouldSkipOrchestrationUpdate: mocks.shouldSkipOrchestrationUpdate,
    diffOrchestration: mocks.diffOrchestration,
  };
});

import { planBackgroundOrchestration } from "../background-orchestration";

describe("planBackgroundOrchestration", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => "mockReset" in fn && fn.mockReset());
  });

  it("没有辅助模型时直接返回 null", async () => {
    mocks.resolveAuxiliaryModel.mockResolvedValue(null);
    const result = await planBackgroundOrchestration({
      conversationId: "conv-1",
      history: [],
      previousState: null,
      availableModels: [],
      credentials: [],
      getApiKey: vi.fn(),
    });
    expect(result).toBeNull();
  });

  it("正常返回下一轮编排结果和有效 chain bindings", async () => {
    const prev = null;
    const next = { version: 2, nodes: [{ id: "n1", role: "architect", title: "方案", status: "active", modelId: "m1", pinned: false }], currentNodeId: "n1", updatedAt: "now" };
    const nextWithChain = { ...next, chainPlan: ["architect"] };
    const bindings = new Map([["architect", "old-model"]]);
    const change = { nodeChanged: true, modelChanged: true, node: next.nodes[0], prevModelId: null };

    mocks.resolveAuxiliaryModel.mockResolvedValue({ model: { modelId: "aux" } });
    mocks.planNodes.mockResolvedValue({ nodes: [{ role: "architect", title: "方案", status: "active" }], reason: "需要方案" });
    mocks.getRoleBindingsForConversation.mockResolvedValue(bindings);
    mocks.usageEventsList.mockResolvedValue([]);
    mocks.buildRolePerformanceScoresFromUsageRows.mockReturnValue(undefined);
    mocks.resolveOrchestration.mockReturnValue(next);
    mocks.computeChain.mockReturnValue(["architect"]);
    mocks.withChainPlan.mockReturnValue(nextWithChain);
    mocks.shouldSkipOrchestrationUpdate.mockReturnValue(false);
    mocks.diffOrchestration.mockReturnValue(change);

    const result = await planBackgroundOrchestration({
      conversationId: "conv-1",
      history: [{ role: "user", content: "做方案" }],
      previousState: prev,
      availableModels: [{}] as never,
      credentials: [],
      getApiKey: vi.fn(),
    });

    expect(result?.next).toBe(next);
    expect(result?.nextWithChain).toBe(nextWithChain);
    expect(result?.chainPlan).toEqual(["architect"]);
    expect(result?.effectiveChainBindings.get("architect")).toBe("m1");
  });
});
