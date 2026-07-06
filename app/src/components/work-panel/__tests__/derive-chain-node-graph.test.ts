import { describe, expect, it } from "vitest";
import { deriveChainNodeGraph } from "../derive-chain-node-graph";
import type { ModelListItem } from "@/lib/api";
import type { OrchestrationState } from "@/lib/llm/orchestrator";
import type { WorkflowSnapshot } from "@/lib/workflow/types";

function model(id: string, name: string): ModelListItem {
  return {
    id,
    name,
    displayName: name,
    contextWindow: null,
    inputPrice: null,
    outputPrice: null,
    enabled: true,
    workRoles: "[]",
    capabilityScore: null,
    providerId: "p1",
    provider: { name: "P", type: "openai" },
  };
}

const models = [
  model("gpt-5-5", "GPT 5.5"),
  model("opus", "Opus 4.8"),
  model("deepseek", "DeepSeek"),
  model("gemini", "Gemini 3.1"),
  model("m3", "MiniMax-M3"),
];

function state(over: Partial<OrchestrationState> = {}): OrchestrationState {
  return {
    version: 2,
    updatedAt: "2026-06-29T00:00:00.000Z",
    currentNodeId: "architect-1",
    chainPlan: ["architect", "backend", "frontend", "tester"],
    nodes: [
      { id: "leader-1", role: "leader", title: "主对话", status: "done", modelId: "gpt-5-5", pinned: false },
      { id: "architect-1", role: "architect", title: "出规划", status: "active", modelId: "opus", pinned: true },
      { id: "backend-1", role: "backend", title: "后端执行", status: "planned", modelId: "deepseek", pinned: false },
      { id: "frontend-1", role: "frontend", title: "前端执行", status: "planned", modelId: "gemini", pinned: false },
      { id: "tester-1", role: "tester", title: "测试", status: "planned", modelId: "m3", pinned: false },
    ],
    ...over,
  };
}

describe("deriveChainNodeGraph", () => {
  it("第一个节点永远是主对话，并显示当前主模型", () => {
    const graph = deriveChainNodeGraph({
      orchestration: state(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    expect(graph.nodes[0]).toMatchObject({
      id: "main-chat",
      stepName: "主对话",
      modelName: "GPT 5.5",
    });
  });

  it("后续节点按工作流从左到右排序", () => {
    const graph = deriveChainNodeGraph({
      orchestration: state(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    expect(graph.nodes.map((n) => n.stepName)).toEqual([
      "主对话",
      "计划方案",
      "后端工程师执行",
      "前端工程师执行",
      "测试",
    ]);
  });

  it("chain 运行时只有第一个未完成接力节点是 running", () => {
    const graph = deriveChainNodeGraph({
      orchestration: state(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: true,
      chainExecutedRoles: ["architect"],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    const byRole = Object.fromEntries(graph.nodes.map((n) => [n.role, n.status]));
    expect(byRole.architect).toBe("done");
    expect(byRole.backend).toBe("running");
    expect(byRole.frontend).toBe("planned");
    expect(byRole.tester).toBe("planned");
  });

  it("支持 skipped 和 aborted 状态覆盖普通状态", () => {
    const graph = deriveChainNodeGraph({
      orchestration: state(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: true,
      chainExecutedRoles: ["architect"],
      chainSkippedRoles: ["backend"],
      chainAbortedRole: "frontend",
    });

    const byRole = Object.fromEntries(graph.nodes.map((n) => [n.role, n.status]));
    expect(byRole.backend).toBe("skipped");
    expect(byRole.frontend).toBe("aborted");
  });
});

// 2026-07-05 加：对弈进行中，"模型博弈"节点原来永远显示死板的"dynamic"占位符（渲染层转成
// "动态分配"），看不出到底哪几个模型在博弈——这里验证真实参与者传进去后节点会显示真实模型名单。
function debateSnapshot(): WorkflowSnapshot {
  return {
    version: 1,
    runId: "run-1",
    conversationId: "conv-1",
    status: "running",
    intent: {
      objective: "优化方案",
      requestedOutcome: "更好的方案",
      taskKind: "analysis",
      executionMode: "answer_only",
      reviewRequested: false,
      debateRequested: true,
      verificationRequired: false,
      securitySensitive: false,
      needsWorkspace: false,
      stickyUntil: [],
    },
    currentNodeId: "debate-1",
    nodes: [
      {
        id: "debate-1",
        phase: "debate",
        title: "模型博弈",
        status: "running",
        optional: false,
        dependsOn: [],
        assignedRoles: [],
        autoAdvance: "never",
      },
    ],
    nextActions: [],
    context: { projectFacts: [], changedFiles: [], riskLevel: "low" },
  };
}

describe("deriveChainNodeGraph — 对弈节点显示真实参与者", () => {
  it("没有传 debateParticipants 时，对弈节点 modelName 是占位符 'dynamic'", () => {
    const graph = deriveChainNodeGraph({
      orchestration: null,
      workflowSnapshot: debateSnapshot(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    const debateNode = graph.nodes.find((n) => n.role === "debate");
    expect(debateNode?.modelName).toBe("dynamic");
  });

  it("传了 debateParticipants 时，对弈节点 modelName 显示真实参与模型名单", () => {
    const graph = deriveChainNodeGraph({
      orchestration: null,
      workflowSnapshot: debateSnapshot(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
      debateParticipants: [
        { modelId: "m3", modelName: "MiniMax-M3" },
        { modelId: "opus", modelName: "Opus 4.8" },
      ],
    });

    const debateNode = graph.nodes.find((n) => n.role === "debate");
    expect(debateNode?.modelName).toBe("MiniMax-M3、Opus 4.8");
  });
});
