import { describe, it, expect, vi } from "vitest";
import {
  deriveExpertAgentMap,
  extractHandoffDecisionFromToolCalls,
  runHandoffBridge,
  buildHandoffToolsForAgent,
  type HandoffBridgeModelRef,
} from "../handoff-bridge";
import { ROLE_IDS } from "../../orchestrator";

const mockModels: HandoffBridgeModelRef[] = [
  { id: "minimax", displayName: "minimax", roleBinding: undefined },
  { id: "deepseek", displayName: "deepseek" },
  { id: "claude-sonnet", displayName: "Claude Sonnet", roleBinding: undefined },
];

describe("deriveExpertAgentMap", () => {
  it("空 roleBindings + selectedModelId → 所有角色用 selectedModel（向后兼容）", () => {
    const map = deriveExpertAgentMap({}, "minimax", mockModels);
    expect(map.size).toBe(8); // 8 角色全部派生出
    for (const roleId of ROLE_IDS) {
      expect(map.get(roleId)?.modelId).toBe("minimax");
    }
  });

  it("角色绑定优先：frontend 绑 deepseek → frontendAgent.modelId = deepseek", () => {
    const map = deriveExpertAgentMap({ frontend: "deepseek" }, "minimax", mockModels);
    expect(map.get("frontend")?.modelId).toBe("deepseek");
    expect(map.get("architect")?.modelId).toBe("minimax"); // 其他用 selectedModel
  });

  it("角色绑的模型不在 models 列表 → 该角色跳过（map 不含）", () => {
    const map = deriveExpertAgentMap({ frontend: "ghost-model" }, "minimax", mockModels);
    expect(map.has("frontend")).toBe(false);
    expect(map.has("architect")).toBe(true); // 其他角色不受影响
  });

  it("systemPrompts 覆盖默认提示", () => {
    const map = deriveExpertAgentMap({}, "minimax", mockModels, {
      architect: "你是资深架构师，擅长分布式系统。",
    });
    expect(map.get("architect")?.systemPrompt).toBe("你是资深架构师，擅长分布式系统。");
    expect(map.get("frontend")?.systemPrompt).toContain("frontend"); // 默认提示含角色名
  });

  it("每个 agent 的 handoffs 来自默认图（不是空数组）", () => {
    const map = deriveExpertAgentMap({}, "minimax", mockModels);
    expect(map.get("leader")?.handoffs.length).toBeGreaterThan(0); // leader 能 handoff 给 7 个角色
    expect(map.get("security")?.handoffs.length).toBe(0); // security 终点
  });
});

describe("extractHandoffDecisionFromToolCalls", () => {
  it("main chat 调了 handoff_to_frontend（在 currentRole 允许列表里）→ 返回 frontend", () => {
    expect(
      extractHandoffDecisionFromToolCalls(
        [{ toolName: "handoff_to_frontend", input: { reason: "x" } }],
        [{ targetId: "frontend" }],
      ),
    ).toBe("frontend");
  });

  it("main chat 没调 handoff → null", () => {
    expect(
      extractHandoffDecisionFromToolCalls(
        [{ toolName: "read", input: { path: "/a" } }],
        [{ targetId: "frontend" }],
      ),
    ).toBeNull();
  });
});

describe("runHandoffBridge", () => {
  it("main chat 没调 handoff → 返回 null（不触发 runHandoffWorkflow）", async () => {
    const agents = deriveExpertAgentMap({}, "minimax", mockModels);
    const runStep = vi.fn();
    const result = await runHandoffBridge({
      startRoleId: "leader",
      messages: [{ role: "user", content: "改个按钮" }],
      agents,
      mainChatToolCalls: [{ toolName: "read", input: { path: "/a" } }], // 没 handoff
      runStep,
    });
    expect(result).toBeNull();
    expect(runStep).not.toHaveBeenCalled();
  });

  it("main chat 调了 handoff → 触发 runHandoffWorkflow，runStep 被调用", async () => {
    const agents = deriveExpertAgentMap({}, "minimax", mockModels);
    const runStep = vi.fn().mockResolvedValueOnce({
      content: "leader 答完",
      toolCalls: [],
    });
    const result = await runHandoffBridge({
      startRoleId: "leader",
      messages: [{ role: "user", content: "做个登录页" }],
      agents,
      mainChatToolCalls: [{ toolName: "handoff_to_frontend", input: { reason: "需要 UI 实现" } }],
      runStep,
    });
    expect(result).not.toBeNull();
    expect(result?.handoffPath).toEqual(["leader"]);
    expect(runStep).toHaveBeenCalledTimes(1); // leader 跑一次（无进一步 handoff）
  });

  it("agents map 缺 startAgent → 返回 null（不炸）", async () => {
    // 构造一个不含 leader 的 map
    const agents = new Map();
    const runStep = vi.fn();
    const result = await runHandoffBridge({
      startRoleId: "leader",
      messages: [{ role: "user", content: "x" }],
      agents,
      mainChatToolCalls: [{ toolName: "handoff_to_frontend" }],
      runStep,
    });
    expect(result).toBeNull();
  });
});

describe("buildHandoffToolsForAgent", () => {
  it("返回的 schema 含 agent.handoffs 所有目标", () => {
    const map = deriveExpertAgentMap({}, "minimax", mockModels);
    const leader = map.get("leader")!;
    const tools = buildHandoffToolsForAgent(leader);
    // 不依赖顺序：sort 后比
    expect(Object.keys(tools).sort()).toEqual(
      [
        "handoff_to_architect",
        "handoff_to_backend",
        "handoff_to_frontend",
        "handoff_to_runner",
        "handoff_to_security",
        "handoff_to_tester",
        "handoff_to_reviewer",
      ].sort()
    );
  });

  it("security agent 的 handoff tools 是空", () => {
    const map = deriveExpertAgentMap({}, "minimax", mockModels);
    const security = map.get("security")!;
    const tools = buildHandoffToolsForAgent(security);
    expect(tools).toEqual({});
  });
});