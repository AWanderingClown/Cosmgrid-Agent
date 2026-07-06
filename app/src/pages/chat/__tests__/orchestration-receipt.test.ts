import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { buildOrchestrationReceipt } from "../orchestration-receipt";
import type { OrchestrationChange, OrchestrationState } from "@/lib/llm/orchestrator";
import type { ModelListItem } from "@/lib/api";

const t = ((key: string, options?: Record<string, unknown>) => {
  const templates: Record<string, string> = {
    "chat.orchestrator.roles.leader": "团队负责人",
    "chat.orchestrator.roles.architect": "架构评审",
    "chat.orchestrator.receiptPlanned": "已规划 {{count}} 个工作节点 · 当前「{{node}}」用 {{model}}",
    "chat.orchestrator.receiptEntered": "进入「{{node}}」节点 · 自动用 {{model}}",
    "chat.orchestrator.receiptSwitched": "「{{node}}」节点自动切到 {{model}}",
    "chat.orchestrator.receiptReason": "判断依据：{{reason}}",
    "chat.orchestrator.receiptNoModel": "（暂无可用模型）",
    "chat.orchestrator.detailNodes": "节点规划",
  };
  const template = templates[key] ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(options?.[k] ?? ""));
}) as unknown as TFunction;

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
  };
}

// 2026-07-04 修复：leader 角色的模型永远不接受编排覆盖（用户手选优先），但回执文案原来
// 直接读 node.modelId，导致显示"规划用了 Claude"而实际（顶部导航栏/工作面板）跑的还是
// 用户手选的 MiniMax——文案和真实执行对不上。
describe("buildOrchestrationReceipt — leader 角色不显示从未生效的 node.modelId", () => {
  const availableModels = [model("minimax-id", "MiniMax-M3"), model("claude-id", "Claude Sonnet")];

  it("leader 节点：回执显示实际生效的 leaderModelId，不是编排算出来但从不生效的 node.modelId", () => {
    const leaderNode = {
      id: "n1",
      role: "leader" as const,
      title: "团队负责人",
      status: "active" as const,
      modelId: "claude-id",
      pinned: false,
    };
    const next: OrchestrationState = { version: 2, nodes: [leaderNode], currentNodeId: "n1", updatedAt: "now" };
    const change: OrchestrationChange = { nodeChanged: true, modelChanged: true, node: leaderNode, prevModelId: null };

    const receipt = buildOrchestrationReceipt({
      change,
      next,
      prev: null,
      reason: "闲聊",
      availableModels,
      leaderModelId: "minimax-id",
      t,
    });

    expect(receipt?.summary).toContain("MiniMax-M3");
    expect(receipt?.summary).not.toContain("Claude Sonnet");
    expect(receipt?.detail).toContain("MiniMax-M3");
    expect(receipt?.detail).not.toContain("Claude Sonnet");
  });

  it("非 leader 节点：照常显示 node.modelId（编排能真正覆盖这类角色）", () => {
    const architectNode = {
      id: "n2",
      role: "architect" as const,
      title: "架构评审",
      status: "active" as const,
      modelId: "claude-id",
      pinned: false,
    };
    const next: OrchestrationState = { version: 2, nodes: [architectNode], currentNodeId: "n2", updatedAt: "now" };
    const change: OrchestrationChange = { nodeChanged: true, modelChanged: true, node: architectNode, prevModelId: null };

    const receipt = buildOrchestrationReceipt({
      change,
      next,
      prev: null,
      reason: "需要方案",
      availableModels,
      leaderModelId: "minimax-id",
      t,
    });

    expect(receipt?.summary).toContain("Claude Sonnet");
  });
});
