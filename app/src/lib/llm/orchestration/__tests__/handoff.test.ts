import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  makeHandoffToolName,
  parseHandoffTargetId,
  parseHandoffDecision,
  defaultEightRolesHandoffGraph,
  buildHandoffTools,
  runHandoffWorkflow,
  HANDOFF_TOOL_PREFIX,
} from "../handoff";
import { ROLE_IDS } from "../../orchestrator";

describe("makeHandoffToolName", () => {
  it("生成 handoff_to_{id}", () => {
    expect(makeHandoffToolName("agnes")).toBe("handoff_to_agnes");
    expect(makeHandoffToolName("deepseek-chat")).toBe("handoff_to_deepseek-chat");
  });
  it("非法字符替换为 _（防注入）", () => {
    expect(makeHandoffToolName("a/b/c")).toBe("handoff_to_a_b_c");
    expect(makeHandoffToolName("a b")).toBe("handoff_to_a_b");
  });
});

describe("parseHandoffTargetId", () => {
  it("从 handoff 工具名反解 id", () => {
    expect(parseHandoffTargetId("handoff_to_agnes")).toBe("agnes");
  });
  it("非 handoff 工具返回 null", () => {
    expect(parseHandoffTargetId("read")).toBeNull();
    expect(parseHandoffTargetId("run_command")).toBeNull();
  });
});

describe("parseHandoffDecision", () => {
  it("toolCalls 含合法 handoff → 返回 targetId", () => {
    const tcs = [{ toolName: "handoff_to_agnes", input: { reason: "x" } }];
    expect(parseHandoffDecision(tcs, ["agnes", "deepseek"])).toBe("agnes");
  });
  it("没 handoff 工具调用 → null", () => {
    const tcs = [{ toolName: "read", input: { path: "/a" } }];
    expect(parseHandoffDecision(tcs, ["agnes"])).toBeNull();
  });
  it("handoff 到未授权目标（不在 targets）→ null（防模型乱调）", () => {
    const tcs = [{ toolName: "handoff_to_evil", input: {} }];
    expect(parseHandoffDecision(tcs, ["agnes"])).toBeNull();
  });
  it("多个 handoff 取第一个", () => {
    const tcs = [
      { toolName: "handoff_to_agnes" },
      { toolName: "handoff_to_deepseek" },
    ];
    expect(parseHandoffDecision(tcs, ["agnes", "deepseek"])).toBe("agnes");
  });
  it("空 toolCalls → null", () => {
    expect(parseHandoffDecision([], ["agnes"])).toBeNull();
  });
});

describe("HANDOFF_TOOL_PREFIX", () => {
  it("前缀常量稳定", () => {
    expect(HANDOFF_TOOL_PREFIX).toBe("handoff_to_");
  });
});

describe("defaultEightRolesHandoffGraph", () => {
  const graph = defaultEightRolesHandoffGraph();

  it("覆盖全部 8 角色（无遗漏、无多余 key）", () => {
    const keys = Object.keys(graph).sort();
    expect(keys).toEqual([...ROLE_IDS].sort());
    expect(keys).toHaveLength(8);
  });

  it("Leader 协调者：可 handoff 给全部 7 个其他角色", () => {
    expect(graph.leader.map((t) => t.targetId).sort()).toEqual(
      ["architect", "backend", "frontend", "runner", "security", "tester", "reviewer"].sort()
    );
  });

  it("Architect 桥梁：只跟前端/后端互转", () => {
    expect(graph.architect.map((t) => t.targetId).sort()).toEqual(["backend", "frontend"]);
  });

  it("Frontend 执行者：可达 backend/architect/runner", () => {
    expect(graph.frontend.map((t) => t.targetId).sort()).toEqual(
      ["architect", "backend", "runner"].sort()
    );
  });

  it("Backend 执行者：可达 frontend/runner", () => {
    expect(graph.backend.map((t) => t.targetId).sort()).toEqual(["frontend", "runner"]);
  });

  it("Runner → Tester（单向，跑完让测试验）", () => {
    expect(graph.runner.map((t) => t.targetId)).toEqual(["tester"]);
  });

  it("Tester/Reviewer 单向流转（防踢皮球：不回头）", () => {
    // Tester → Reviewer/Security，不回头
    expect(graph.tester.map((t) => t.targetId).sort()).toEqual(["reviewer", "security"]);
    // Tester 不能再回 Runner（防踢皮球）
    expect(graph.tester.find((t) => t.targetId === "runner")).toBeUndefined();
    // Reviewer → Security，不回头
    expect(graph.reviewer.map((t) => t.targetId)).toEqual(["security"]);
  });

  it("Security 终点：不转出（任务收尾）", () => {
    expect(graph.security).toEqual([]);
  });

  it("parseHandoffDecision 用默认图验证：leader 调用 handoff_to_frontend → frontend", () => {
    const tcs = [{ toolName: "handoff_to_frontend", input: { reason: "改个按钮颜色" } }];
    expect(parseHandoffDecision(tcs, graph.leader.map((t) => t.targetId))).toBe("frontend");
  });

  it("parseHandoffDecision 用默认图验证：security 调 handoff_to_leader → null（security 是终点）", () => {
    const tcs = [{ toolName: "handoff_to_leader" }];
    expect(parseHandoffDecision(tcs, graph.security.map((t) => t.targetId))).toBeNull();
  });

  it("每个 handoff 都有 description（用户能看懂工具是干嘛的）", () => {
    for (const role of ROLE_IDS) {
      for (const target of graph[role]) {
        expect(target.description, `${role} → ${target.targetId} 缺 description`).toBeTruthy();
      }
    }
  });
});

describe("buildHandoffTools", () => {
  const graph = defaultEightRolesHandoffGraph();

  it("空 targets → 空 Record", () => {
    expect(buildHandoffTools([])).toEqual({});
  });

  it("返回的 keys = makeHandoffToolName(targetId)", () => {
    const targets = [
      { targetId: "frontend", description: "前端" },
      { targetId: "backend", description: "后端" },
    ];
    const tools = buildHandoffTools(targets);
    expect(Object.keys(tools).sort()).toEqual(["handoff_to_backend", "handoff_to_frontend"]);
  });

  it("每个 Tool 含 description（包含 targetId + 原描述）", () => {
    const tools = buildHandoffTools([
      { targetId: "frontend", description: "实现 UI" },
    ]);
    expect(tools.handoff_to_frontend.description).toContain("frontend");
    expect(tools.handoff_to_frontend.description).toContain("实现 UI");
  });

  it("每个 Tool 的 inputSchema 接受 reason string（zod 验证）", () => {
    const tools = buildHandoffTools([{ targetId: "frontend" }]);
    // AI SDK 5.x 的 inputSchema 是 FlexibleSchema<any>（union），测试时断言为 z.ZodObject
    const schema = tools.handoff_to_frontend.inputSchema as z.ZodObject<{ reason: z.ZodString }>;
    // 合法 reason 不抛
    expect(() => schema.parse({ reason: "按钮颜色错了" })).not.toThrow();
    // 缺 reason → 抛
    expect(() => schema.parse({})).toThrow();
  });

  it("用默认图：leader.tools 包含 7 个 handoff 工具", () => {
    const leaderTools = buildHandoffTools(graph.leader);
    expect(Object.keys(leaderTools).sort()).toEqual(
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

  it("用默认图：security.tools 是空（security 是终点）", () => {
    const securityTools = buildHandoffTools(graph.security);
    expect(securityTools).toEqual({});
  });
});

describe("runHandoffWorkflow", () => {
  // 测试用 mock ExpertAgent（modelId/systemPrompt 占位即可）
  const makeAgent = (id: string, handoffs: { targetId: string; description?: string }[]) => ({
    id,
    modelId: `model-${id}`,
    systemPrompt: `You are ${id}`,
    handoffs,
  });

  it("case 1：单 agent 无 handoff → runStep 调一次即返回", async () => {
    const agents = new Map([
      ["architect", makeAgent("architect", [])],
    ]);
    const runStep = vi.fn().mockResolvedValue({
      content: "架构方案已出。",
      toolCalls: [],
    });
    const result = await runHandoffWorkflow("architect", agents, "出个方案", runStep);
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(result.finalContent).toBe("架构方案已出。");
    expect(result.handoffPath).toEqual(["architect"]);
    expect(result.truncated).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("case 2：leader → architect 接力，messages 累积正确", async () => {
    const agents = new Map([
      ["leader", makeAgent("leader", [{ targetId: "architect", description: "出方案" }])],
      ["architect", makeAgent("architect", [])],
    ]);
    // leader 第一跳调 handoff_to_architect
    // architect 第二跳答完（无 handoff）
    const runStep = vi
      .fn()
      .mockResolvedValueOnce({
        content: "leader 决定让 architect 出方案。",
        toolCalls: [{ toolName: "handoff_to_architect", input: { reason: "需要架构方案" } }],
      })
      .mockResolvedValueOnce({
        content: "架构方案：建 3 张表 + 1 API。",
        toolCalls: [],
      });
    const result = await runHandoffWorkflow("leader", agents, "做个待办小应用", runStep);
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(result.finalContent).toBe("架构方案：建 3 张表 + 1 API。");
    expect(result.handoffPath).toEqual(["leader", "architect"]);

    // 验证 messages 累积：第 1 跳 leader 跑前 messages = [user: "做个待办小应用"]
    // 注意：mock.calls 记的是 messages 引用，必须 spread 复制（否则看到循环最终状态）
    const firstCallMessages = [...runStep.mock.calls[0][1]];
    expect(firstCallMessages).toEqual([{ role: "user", content: "做个待办小应用" }]);

    // 第 2 跳 architect 跑前 messages = [user, assistant(leader), user(System handoff)]
    const secondCallMessages = [...runStep.mock.calls[1][1]];
    expect(secondCallMessages).toHaveLength(3);
    expect(secondCallMessages[0]).toEqual({ role: "user", content: "做个待办小应用" });
    expect(secondCallMessages[1]).toEqual({
      role: "assistant",
      content: "leader 决定让 architect 出方案。",
    });
    expect(secondCallMessages[2]).toMatchObject({
      role: "user",
      content: expect.stringContaining("[System handoff]") as string,
    });
    expect(secondCallMessages[2].content).toContain("leader");
    expect(secondCallMessages[2].content).toContain("architect");
    expect(secondCallMessages[2].content).toContain("需要架构方案");
  });

  it("case 3：链条上限 maxHandoffs=2 触发截断，truncated=true", async () => {
    // 链：leader → architect → frontend → backend → runner → tester
    // maxHandoffs=2 = 最多 2 次 handoff = path.length ≤ 3（含 startAgent）
    const agents = new Map([
      ["leader", makeAgent("leader", [{ targetId: "architect" }])],
      ["architect", makeAgent("architect", [{ targetId: "frontend" }])],
      ["frontend", makeAgent("frontend", [{ targetId: "backend" }])],
      ["backend", makeAgent("backend", [])],
    ]);
    // leader → architect（handoff #1）
    // architect → frontend（handoff #2，达到 maxHandoffs）
    // frontend 想再 handoff_to_backend → truncated
    const runStep = vi
      .fn()
      .mockResolvedValueOnce({
        content: "leader",
        toolCalls: [{ toolName: "handoff_to_architect", input: { reason: "r" } }],
      })
      .mockResolvedValueOnce({
        content: "architect",
        toolCalls: [{ toolName: "handoff_to_frontend", input: { reason: "r" } }],
      })
      .mockResolvedValueOnce({
        content: "frontend 想再 handoff",
        toolCalls: [{ toolName: "handoff_to_backend", input: { reason: "r" } }],
      });
    const result = await runHandoffWorkflow("leader", agents, "x", runStep, { maxHandoffs: 2 });
    expect(result.handoffPath).toEqual(["leader", "architect", "frontend"]);
    expect(result.truncated).toBe(true);
    expect(result.finalContent).toBe("frontend 想再 handoff");
    // runStep 只跑了 3 次（每次的 agent 都被试过 handoff 或回答）
    expect(runStep).toHaveBeenCalledTimes(3);
  });

  it("case 4：未授权 handoff 目标被拒（模型调了不在 allowed 列表的工具 → 当作无 handoff）", async () => {
    const agents = new Map([
      ["leader", makeAgent("leader", [{ targetId: "frontend" }])], // 只允许 frontend
    ]);
    // 模型调了 handoff_to_backend（不在 leader.handoffs）→ parseHandoffDecision 返 null
    const runStep = vi.fn().mockResolvedValue({
      content: "leader 答完了。",
      toolCalls: [{ toolName: "handoff_to_backend", input: { reason: "r" } }],
    });
    const result = await runHandoffWorkflow("leader", agents, "x", runStep);
    expect(result.handoffPath).toEqual(["leader"]);
    expect(result.finalContent).toBe("leader 答完了。");
    expect(runStep).toHaveBeenCalledTimes(1);
  });

  it("case 5：runStep 抛错 → result.error 填上，不炸主对话", async () => {
    const agents = new Map([["leader", makeAgent("leader", [])]]);
    const runStep = vi.fn().mockRejectedValue(new Error("模型 API 500"));
    const result = await runHandoffWorkflow("leader", agents, "x", runStep);
    expect(result.error).toBe("模型 API 500");
    expect(result.handoffPath).toEqual(["leader"]);
  });

  it("case 6：agents map 缺 startAgentId → result.error 填上", async () => {
    const agents = new Map<string, ReturnType<typeof makeAgent>>();
    const runStep = vi.fn();
    const result = await runHandoffWorkflow("ghost", agents, "x", runStep);
    expect(result.error).toContain('Agent "ghost" not found');
    expect(runStep).not.toHaveBeenCalled();
  });
});
