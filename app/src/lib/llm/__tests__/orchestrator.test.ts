// orchestrator 单测（阶段 C 重写）：LLM 角色规划（mock generateObject）+ 纯函数模型分配/接管/diff/派生
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateObjectMock = vi.fn();
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

import {
  planNodes,
  resolveOrchestration,
  pinModelToCurrentNode,
  pinModelToNode,
  currentNode,
  diffOrchestration,
  pickOrchestratorModel,
  activatedRoles,
  parseOrchestration,
  serializeOrchestration,
  computeChain,
  withChainPlan,
  deriveChainProgress,
  ROLE_WATCH_GRAPH,
  MAX_CHAIN_LENGTH,
  ROLE_IDS,
  ORCHESTRATION_VERSION,
  type RoleId,
  type OrchestrationPlan,
  type OrchestrationState,
  type AssignableModel,
} from "../orchestrator";
import type { LanguageModel } from "../provider-factory";

const fakeModel = {} as LanguageModel;
const fixedNow = () => "2026-06-25T00:00:00.000Z";

/** 造一个可评分模型；name 决定档位，workRoles 决定它擅长的角色（13 个 WorkRole 枚举之一） */
function model(id: string, name: string, workRoles: string[] = []): AssignableModel {
  return { id, name, capabilityScore: null, workRoles: JSON.stringify(workRoles) };
}

// 三个模型：强模型(规划/审查)、写码模型(前后端)、便宜模型(测试)
const flagship = model("m-flagship", "o1-flagship", ["planning", "review", "final_review"]);
const coder = model("m-coder", "claude-sonnet-4-6", ["backend", "frontend"]);
const cheap = model("m-cheap", "claude-haiku-4-5", ["testing"]);
const allModels = [flagship, coder, cheap];

/** 造一个 OrchestrationPlan（默认单节点 leader active） */
function plan(over: Partial<OrchestrationPlan> = {}): OrchestrationPlan {
  return {
    currentNodeRole: "leader",
    nodes: [{ role: "leader", title: "对话答疑", status: "active" }],
    reason: "默认",
    ...over,
  };
}

describe("planNodes（LLM 规划，mock generateObject）", () => {
  beforeEach(() => generateObjectMock.mockReset());

  it("把对话历史与已有角色图都喂进 prompt，返回结构化规划", async () => {
    const fakePlan = plan({
      nodes: [
        { role: "architect", title: "规划方案", status: "done" },
        { role: "frontend", title: "写 TodoList.tsx", status: "active" },
      ],
      currentNodeRole: "frontend",
    });
    generateObjectMock.mockResolvedValue({ object: fakePlan });

    const prev: OrchestrationState = {
      version: ORCHESTRATION_VERSION,
      nodes: [{ id: "p1", role: "leader", title: "对话", status: "done", modelId: "m-cheap", pinned: false }],
      currentNodeId: "p1",
      updatedAt: fixedNow(),
    };

    const result = await planNodes(
      fakeModel,
      [
        { role: "user", content: "帮我做个待办 app" },
        { role: "assistant", content: "好，先把骨架搭出来" },
      ],
      prev,
    );

    expect(result).toEqual(fakePlan);
    const args = generateObjectMock.mock.calls[0]![0] as { prompt: string; model: unknown };
    expect(args.model).toBe(fakeModel);
    expect(args.prompt).toContain("帮我做个待办 app");
    expect(args.prompt).toContain("对话"); // 已有角色图被带入（滚动规划）
  });

  it("空历史也能调用（prompt 含占位）", async () => {
    generateObjectMock.mockResolvedValue({ object: plan() });
    await planNodes(fakeModel, []);
    const args = generateObjectMock.mock.calls[0]![0] as { prompt: string };
    expect(args.prompt).toContain("还没有任何内容");
    expect(args.prompt).toContain("还没有规划过角色");
  });

  it("prompt 里硬编码 leader 必含 + 角色少而精规则（防过度激活）", async () => {
    generateObjectMock.mockResolvedValue({ object: plan() });
    await planNodes(fakeModel, [{ role: "user", content: "你好" }]);
    const args = generateObjectMock.mock.calls[0]![0] as { prompt: string };
    expect(args.prompt).toContain("leader 必须永远在");
    expect(args.prompt).toContain("只给 1 个 leader");
    expect(args.prompt).toContain("按钮改蓝色");
    expect(args.prompt).toContain("前端活写 frontend，后端活写 backend");
  });
});

describe("resolveOrchestration（纯函数：按角色定模型）", () => {
  it("每个角色按 ROLE_TO_WORK_ROLE 映射自动选最合适的模型", () => {
    const p = plan({
      nodes: [
        { role: "architect", title: "规划", status: "done" },
        { role: "frontend", title: "写前端", status: "active" },
        { role: "tester", title: "测试", status: "planned" },
      ],
      currentNodeRole: "frontend",
    });
    const state = resolveOrchestration(p, allModels, null, undefined, fixedNow);

    const byRole = Object.fromEntries(state.nodes.map((n) => [n.role, n.modelId]));
    expect(byRole.architect).toBe("m-flagship"); // architect → planning workRole → flagship
    expect(byRole.frontend).toBe("m-coder"); // frontend → frontend workRole → coder
    expect(byRole.tester).toBe("m-cheap"); // tester → testing workRole → cheap
  });

  it("currentNodeId 指向 currentNodeRole 的 active 节点", () => {
    const p = plan({
      nodes: [
        { role: "architect", title: "规划", status: "done" },
        { role: "frontend", title: "写前端", status: "active" },
      ],
      currentNodeRole: "frontend",
    });
    const state = resolveOrchestration(p, allModels, null, undefined, fixedNow);
    expect(currentNode(state)?.role).toBe("frontend");
  });

  it("继承旧节点的 id（按 role 匹配），保住稳定身份", () => {
    const prev = resolveOrchestration(
      plan({ nodes: [{ role: "leader", title: "对话", status: "active" }], currentNodeRole: "leader" }),
      allModels,
      null,
      undefined,
      fixedNow,
    );
    const leaderId = prev.nodes[0]!.id;

    const next = resolveOrchestration(
      plan({
        nodes: [
          { role: "leader", title: "对话", status: "done" },
          { role: "frontend", title: "写前端", status: "active" },
        ],
        currentNodeRole: "frontend",
      }),
      allModels,
      prev,
      undefined,
      fixedNow,
    );
    expect(next.nodes.find((n) => n.role === "leader")!.id).toBe(leaderId);
  });

  it("用户钉住的节点不被自动覆盖模型", () => {
    let prev = resolveOrchestration(
      plan({ nodes: [{ role: "frontend", title: "写前端", status: "active" }], currentNodeRole: "frontend" }),
      allModels,
      null,
      undefined,
      fixedNow,
    );
    // 用户手动把 frontend 节点切到 flagship 并钉住
    prev = pinModelToCurrentNode(prev, "m-flagship", fixedNow);

    // 再跑一次编排（仍含 frontend 节点）→ 不该把它自动换回 coder
    const next = resolveOrchestration(
      plan({ nodes: [{ role: "frontend", title: "写前端", status: "active" }], currentNodeRole: "frontend" }),
      allModels,
      prev,
      undefined,
      fixedNow,
    );
    const frontendNode = next.nodes.find((n) => n.role === "frontend")!;
    expect(frontendNode.modelId).toBe("m-flagship");
    expect(frontendNode.pinned).toBe(true);
  });

  it("没有可用模型时 modelId 为 null（不崩）", () => {
    const state = resolveOrchestration(plan(), [], null, undefined, fixedNow);
    expect(state.nodes[0]!.modelId).toBeNull();
  });

  it("【防过度激活】LLM 只输出 leader（极简「你好」），resolveOrchestration 只激活 leader", () => {
    const minimalPlan = plan({
      nodes: [{ role: "leader", title: "对话答疑", status: "active" }],
      currentNodeRole: "leader",
      reason: "用户只说了你好，单次问答",
    });
    const state = resolveOrchestration(minimalPlan, allModels, null, undefined, fixedNow);
    expect(activatedRoles(state)).toEqual(["leader"]);
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]!.role).toBe("leader");
  });
});

describe("resolveOrchestration roleBindings（阶段 D：用户角色绑定）", () => {
  it("绑定生效：roleBindings={frontend→m-coder} → 该角色用绑定模型", () => {
    const bindings = new Map<RoleId, string>([["frontend", "m-coder"]]);
    // 注意：即使 m-flagship 在分数上更适合 frontend role，绑定仍覆盖（用户明确指定）
    const p = plan({
      nodes: [{ role: "frontend", title: "写前端", status: "active" }],
      currentNodeRole: "frontend",
    });
    const state = resolveOrchestration(p, allModels, null, bindings, fixedNow);
    const frontend = state.nodes.find((n) => n.role === "frontend")!;
    expect(frontend.modelId).toBe("m-coder");
  });

  it("绑定不覆盖用户手动 pin（防倒退：用户手动 pin 永远赢）", () => {
    // 用户手动把 frontend 节点钉到 m-coder
    let prev = resolveOrchestration(
      plan({ nodes: [{ role: "frontend", title: "写前端", status: "active" }], currentNodeRole: "frontend" }),
      allModels,
      null,
      undefined,
      fixedNow,
    );
    prev = pinModelToCurrentNode(prev, "m-coder", fixedNow); // pinned=true, modelId=m-coder

    // 用户在 TemplatesPage 把 frontend 绑到 m-flagship（想覆盖）
    const bindings = new Map<RoleId, string>([["frontend", "m-flagship"]]);

    // 再跑一次编排 → 用户手动 pin 必须赢，不能被绑定覆盖
    const next = resolveOrchestration(
      plan({ nodes: [{ role: "frontend", title: "写前端", status: "active" }], currentNodeRole: "frontend" }),
      allModels,
      prev,
      bindings,
      fixedNow,
    );
    const frontend = next.nodes.find((n) => n.role === "frontend")!;
    expect(frontend.modelId).toBe("m-coder"); // 用户手动 pin 赢，不被绑定覆盖
    expect(frontend.pinned).toBe(true); // 仍标 pinned
  });

  it("绑定生效但**不标 pinned=true**（pinned 只留给用户手动点节点；模板绑定改了即时生效又不冒充手选）", () => {
    const bindings = new Map<RoleId, string>([["frontend", "m-coder"]]);
    const p = plan({
      nodes: [{ role: "frontend", title: "写前端", status: "active" }],
      currentNodeRole: "frontend",
    });
    const state = resolveOrchestration(p, allModels, null, bindings, fixedNow);
    const frontend = state.nodes.find((n) => n.role === "frontend")!;
    expect(frontend.modelId).toBe("m-coder");
    expect(frontend.pinned).toBe(false); // 关键：绑定不冒充用户手选
  });

  it("绑定的 modelId 不在 availableModels → 忽略该绑定，fallback 自动选", () => {
    // 用户配的模型被供应商删了 / 禁用了
    const bindings = new Map<RoleId, string>([["frontend", "m-deleted"]]);
    const p = plan({
      nodes: [{ role: "frontend", title: "写前端", status: "active" }],
      currentNodeRole: "frontend",
    });
    const state = resolveOrchestration(p, allModels, null, bindings, fixedNow);
    const frontend = state.nodes.find((n) => n.role === "frontend")!;
    // 绑定忽略，自动选（coder 擅长 frontend）
    expect(frontend.modelId).toBe("m-coder");
  });

  it("多角色绑定：前端/审查各绑一个，互不干扰", () => {
    const bindings = new Map<RoleId, string>([
      ["frontend", "m-coder"],
      ["reviewer", "m-flagship"],
    ]);
    const p = plan({
      nodes: [
        { role: "frontend", title: "写前端", status: "done" },
        { role: "reviewer", title: "审查代码", status: "active" },
      ],
      currentNodeRole: "reviewer",
    });
    const state = resolveOrchestration(p, allModels, null, bindings, fixedNow);
    const byRole = Object.fromEntries(state.nodes.map((n) => [n.role, n.modelId]));
    expect(byRole.frontend).toBe("m-coder");
    expect(byRole.reviewer).toBe("m-flagship");
    // 两个节点都不应标 pinned=true
    expect(state.nodes.every((n) => !n.pinned)).toBe(true);
  });

  it("没传 roleBindings → 走原自动选（向后兼容，0 回归）", () => {
    const p = plan({
      nodes: [{ role: "frontend", title: "写前端", status: "active" }],
      currentNodeRole: "frontend",
    });
    const state = resolveOrchestration(p, allModels, null, undefined, fixedNow);
    const frontend = state.nodes.find((n) => n.role === "frontend")!;
    expect(frontend.modelId).toBe("m-coder"); // 同 fallback 行为
    expect(frontend.pinned).toBe(false);
  });

  it("绑定 + 继承 prev modelId：prev.frontend (pinned=false, modelId=m-flagship) + binding={frontend→m-coder} → 绑定赢", () => {
    // 上一轮选了 flagship，下次用户在模板改绑 coder → 这一轮必须用 coder（改绑定即时生效）
    const prev = resolveOrchestration(
      plan({ nodes: [{ role: "frontend", title: "写前端", status: "active" }], currentNodeRole: "frontend" }),
      [flagship], // 只给 flagship 一个模型 → 上轮只能选 flagship
      null,
      undefined,
      fixedNow,
    );
    expect(prev.nodes[0]!.modelId).toBe("m-flagship");

    // 现在模板绑了 coder（可用模型加入了 coder）→ 这轮用 coder
    const bindings = new Map<RoleId, string>([["frontend", "m-coder"]]);
    const next = resolveOrchestration(
      plan({ nodes: [{ role: "frontend", title: "写前端", status: "active" }], currentNodeRole: "frontend" }),
      allModels, // 加了 coder
      prev,
      bindings,
      fixedNow,
    );
    expect(next.nodes[0]!.modelId).toBe("m-coder"); // 绑定赢过 prev 继承
  });
});

describe("activatedRoles（派生：单一来源，从 nodes 派生 unique set）", () => {
  it("空 state 返回空数组", () => {
    expect(activatedRoles(null)).toEqual([]);
    expect(activatedRoles({ version: 2, nodes: [], currentNodeId: null, updatedAt: "" })).toEqual([]);
  });

  it("从 nodes 派生 unique 角色集合，按 ROLE_IDS 顺序", () => {
    const state: OrchestrationState = {
      version: ORCHESTRATION_VERSION,
      nodes: [
        { id: "n1", role: "architect", title: "规划", status: "done", modelId: null, pinned: false },
        { id: "n2", role: "frontend", title: "前端", status: "active", modelId: null, pinned: false },
        // 重复 frontend（不应该出现但要兜住）→ 派生时去重
        { id: "n3", role: "frontend", title: "前端第二轮", status: "planned", modelId: null, pinned: false },
        { id: "n4", role: "runner", title: "跑 build", status: "planned", modelId: null, pinned: false },
      ],
      currentNodeId: "n2",
      updatedAt: fixedNow(),
    };
    expect(activatedRoles(state)).toEqual(["architect", "frontend", "runner"]);
  });

  it("state 里没有 schema 外的角色也能兜住（容错：只统计 ROLE_IDS 内的）", () => {
    // 直接构造一个带非法 role 的 state（模拟落库漂移）
    const state = {
      version: ORCHESTRATION_VERSION,
      nodes: [
        { id: "n1", role: "leader" as const, title: "x", status: "active" as const, modelId: null, pinned: false },
        { id: "n2", role: "phantom" as never, title: "y", status: "active" as const, modelId: null, pinned: false },
      ],
      currentNodeId: "n1",
      updatedAt: fixedNow(),
    };
    // 不抛错，返回 ROLE_IDS 内有的部分
    expect(activatedRoles(state)).toEqual(["leader"]);
  });
});

describe("pinModelToCurrentNode", () => {
  it("只钉当前节点，其余不动（不可变）", () => {
    const state = resolveOrchestration(
      plan({
        nodes: [
          { role: "architect", title: "规划", status: "done" },
          { role: "frontend", title: "写前端", status: "active" },
        ],
        currentNodeRole: "frontend",
      }),
      allModels,
      null,
      undefined,
      fixedNow,
    );
    const pinned = pinModelToCurrentNode(state, "m-flagship", fixedNow);
    expect(pinned).not.toBe(state); // 新对象
    const frontend = pinned.nodes.find((n) => n.role === "frontend")!;
    const architect = pinned.nodes.find((n) => n.role === "architect")!;
    expect(frontend.modelId).toBe("m-flagship");
    expect(frontend.pinned).toBe(true);
    expect(architect.pinned).toBe(false);
  });
});

describe("pinModelToNode（提前给任意节点指定模型）", () => {
  it("能钉住还没轮到的 planned 节点，且不影响当前节点", () => {
    const state = resolveOrchestration(
      plan({
        nodes: [
          { role: "frontend", title: "写前端", status: "active" },
          { role: "tester", title: "测试", status: "planned" },
        ],
        currentNodeRole: "frontend",
      }),
      allModels,
      null,
      undefined,
      fixedNow,
    );
    const testerNode = state.nodes.find((n) => n.role === "tester")!;
    // 提前把"测试"节点（未轮到）指定成 flagship
    const next = pinModelToNode(state, testerNode.id, "m-flagship", fixedNow);
    const testerAfter = next.nodes.find((n) => n.role === "tester")!;
    const frontendAfter = next.nodes.find((n) => n.role === "frontend")!;
    expect(testerAfter.modelId).toBe("m-flagship");
    expect(testerAfter.pinned).toBe(true);
    expect(frontendAfter.pinned).toBe(false); // 当前节点不受影响
  });

  it("钉住的未来节点，轮到时编排不自动覆盖", () => {
    let state = resolveOrchestration(
      plan({
        nodes: [
          { role: "frontend", title: "写前端", status: "active" },
          { role: "tester", title: "测试", status: "planned" },
        ],
        currentNodeRole: "frontend",
      }),
      allModels,
      null,
      undefined,
      fixedNow,
    );
    const testerId = state.nodes.find((n) => n.role === "tester")!.id;
    state = pinModelToNode(state, testerId, "m-flagship", fixedNow);
    // 推进到 tester 节点重算
    const next = resolveOrchestration(
      plan({
        nodes: [
          { role: "frontend", title: "写前端", status: "done" },
          { role: "tester", title: "测试", status: "active" },
        ],
        currentNodeRole: "tester",
      }),
      allModels,
      state,
      undefined,
      fixedNow,
    );
    expect(next.nodes.find((n) => n.role === "tester")!.modelId).toBe("m-flagship"); // 没被自动换回 cheap
  });
});

describe("diffOrchestration（该不该切+写回执）", () => {
  const s1 = resolveOrchestration(
    plan({ nodes: [{ role: "leader", title: "对话", status: "active" }], currentNodeRole: "leader" }),
    allModels,
    null,
    undefined,
    fixedNow,
  );

  it("全新状态算进入节点", () => {
    const d = diffOrchestration(null, s1);
    expect(d.nodeChanged).toBe(true);
    expect(d.node?.role).toBe("leader");
  });

  it("进入新节点 → nodeChanged + modelChanged", () => {
    // s1: leader 节点被用户手动钉到 m-cheap（用户选了便宜模型闲聊）
    let s1p = resolveOrchestration(
      plan({ nodes: [{ role: "leader", title: "对话", status: "active" }], currentNodeRole: "leader" }),
      allModels,
      null,
      undefined,
      fixedNow,
    );
    s1p = pinModelToCurrentNode(s1p, "m-cheap", fixedNow);

    // s2: 用户开始写前端 → 编排切到 frontend 节点 + 自动选 m-coder
    const s2 = resolveOrchestration(
      plan({
        nodes: [
          { role: "leader", title: "对话", status: "done" },
          { role: "frontend", title: "写前端", status: "active" },
        ],
        currentNodeRole: "frontend",
      }),
      allModels,
      s1p,
      undefined,
      fixedNow,
    );
    const d = diffOrchestration(s1p, s2);
    expect(d.nodeChanged).toBe(true);
    expect(d.modelChanged).toBe(true); // cheap (pinned) → coder (auto for frontend)
    expect(d.node?.role).toBe("frontend");
    expect(d.prevModelId).toBe("m-cheap");
  });

  it("同一节点重算、模型没变 → 不切不写回执", () => {
    const d = diffOrchestration(s1, s1);
    expect(d.nodeChanged).toBe(false);
    expect(d.modelChanged).toBe(false);
  });
});

describe("parseOrchestration（落库 v2 守卫 + v1 数据无损失效）", () => {
  it("null 输入返回 null（不崩）", () => {
    expect(parseOrchestration(null)).toBeNull();
  });

  it("坏 JSON 返回 null（不抛错）", () => {
    expect(parseOrchestration("{not valid")).toBeNull();
  });

  it("空字符串返回 null", () => {
    expect(parseOrchestration("")).toBeNull();
  });

  it("非对象（数组/字符串）返回 null", () => {
    expect(parseOrchestration("[]")).toBeNull();
    expect(parseOrchestration('"hi"')).toBeNull();
  });

  it("v1 数据（ORCHESTRATION_VERSION=1）返回 null（阶段 C 升级：编排是低频临时态，无损重规划）", () => {
    const v1 = {
      version: 1,
      nodes: [{ id: "x", kind: "planning", title: "t", status: "active", modelId: null, pinned: false }],
      currentNodeId: "x",
      updatedAt: "2026-06-24T00:00:00Z",
    };
    expect(parseOrchestration(JSON.stringify(v1))).toBeNull();
  });

  it("v2 但 nodes 缺 role 字段（漂移）→ 返回 null", () => {
    const drift = {
      version: ORCHESTRATION_VERSION,
      nodes: [{ id: "x", title: "t", status: "active", modelId: null, pinned: false }], // 没有 role
      currentNodeId: "x",
      updatedAt: "2026-06-25T00:00:00Z",
    };
    expect(parseOrchestration(JSON.stringify(drift))).toBeNull();
  });

  it("v2 合法数据往返 OK", () => {
    const state = resolveOrchestration(plan(), allModels, null, undefined, fixedNow);
    const json = serializeOrchestration(state);
    const parsed = parseOrchestration(json);
    expect(parsed).toEqual(state);
  });
});

describe("pickOrchestratorModel（选最省的跑编排）", () => {
  it("优先 fast 档", () => {
    expect(pickOrchestratorModel(allModels)?.id).toBe("m-cheap");
  });
  it("没 fast 档退数组第一个", () => {
    expect(pickOrchestratorModel([flagship, coder])?.id).toBe("m-flagship");
  });
  it("空数组返回 null", () => {
    expect(pickOrchestratorModel([])).toBeNull();
  });
});

describe("ROLE_IDS 常量", () => {
  it("覆盖 8 个团队角色（leader/architect/frontend/backend/runner/tester/reviewer/security）", () => {
    expect(ROLE_IDS).toEqual([
      "leader",
      "architect",
      "frontend",
      "backend",
      "runner",
      "tester",
      "reviewer",
      "security",
    ]);
  });

  it("ORCHESTRATION_VERSION 是 2（v1 数据 parseOrchestration 返回 null）", () => {
    expect(ORCHESTRATION_VERSION).toBe(2);
  });
});

describe("watch 图 + computeChain（阶段 E1：零 LLM，纯逻辑+展示）", () => {
  it("ROLE_WATCH_GRAPH 覆盖 8 个角色，leader 是空数组（起点）", () => {
    expect(Object.keys(ROLE_WATCH_GRAPH).sort()).toEqual([...ROLE_IDS].sort());
    expect(ROLE_WATCH_GRAPH.leader).toEqual([]); // 起点
  });

  it("MAX_CHAIN_LENGTH = 3（用户产品决策：跑顺再放 5）", () => {
    expect(MAX_CHAIN_LENGTH).toBe(3);
  });

  it("单角色 [leader] → computeChain 返 []（不接力，你重点核②）", () => {
    const p = plan({
      nodes: [{ role: "leader", title: "对话答疑", status: "active" }],
      currentNodeRole: "leader",
    });
    expect(computeChain(p)).toEqual([]);
  });

  it("两角色 [leader, frontend] → computeChain 返 [frontend]（leader 过滤）", () => {
    const p = plan({
      nodes: [
        { role: "leader", title: "对话", status: "active" },
        { role: "frontend", title: "写前端", status: "planned" },
      ],
      currentNodeRole: "frontend",
    });
    expect(computeChain(p)).toEqual(["frontend"]);
  });

  it("复杂任务 [leader, architect, frontend, backend, runner, tester, reviewer] → chain 封顶 3（你重点核①③）", () => {
    const p = plan({
      nodes: [
        { role: "leader", title: "对话", status: "active" },
        { role: "architect", title: "设计", status: "planned" },
        { role: "frontend", title: "前端", status: "planned" },
        { role: "backend", title: "后端", status: "planned" },
        { role: "runner", title: "跑 build", status: "planned" },
        { role: "tester", title: "测试", status: "planned" },
        { role: "reviewer", title: "审查", status: "planned" },
      ],
      currentNodeRole: "architect",
    });
    const chain = computeChain(p);
    expect(chain.length).toBe(3); // 封顶
    expect(chain).toEqual(["architect", "frontend", "backend"]); // 按 plan 顺序 + 封顶
  });

  it("computeChain 按 plan.nodes 顺序（不是 ROLE_IDS 顺序）——尊重 LLM 排的 topological", () => {
    const p = plan({
      nodes: [
        { role: "leader", title: "x", status: "active" },
        { role: "runner", title: "y", status: "planned" },  // 先 runner（违反 watch 图，但 LLM 这么排就算它的）
        { role: "frontend", title: "z", status: "planned" },
      ],
      currentNodeRole: "runner",
    });
    expect(computeChain(p)).toEqual(["runner", "frontend"]); // 按 plan 顺序，不重排
  });

  it("withChainPlan 不可变：不修改原 state", () => {
    const state = resolveOrchestration(plan(), allModels, null, undefined, fixedNow);
    const next = withChainPlan(state, ["frontend", "runner"]);
    expect(state.chainPlan).toBeUndefined(); // 原 state 不变
    expect(next).not.toBe(state); // 新对象
    expect(next.chainPlan).toEqual(["frontend", "runner"]);
  });

  it("parseOrchestration 向后兼容：v2 数据无 chainPlan 字段 → 不崩，state.chainPlan=undefined", () => {
    const v2NoChain = {
      version: ORCHESTRATION_VERSION,
      nodes: [{ id: "n1", role: "leader", title: "x", status: "active", modelId: null, pinned: false }],
      currentNodeId: "n1",
      updatedAt: "2026-06-26T00:00:00Z",
      // 注意：没有 chainPlan 字段
    };
    const parsed = parseOrchestration(JSON.stringify(v2NoChain));
    expect(parsed).not.toBeNull();
    expect(parsed!.chainPlan).toBeUndefined();
  });

  it("parseOrchestration 保留 chainPlan 字段（v2 数据带 chainPlan）", () => {
    const v2WithChain = {
      version: ORCHESTRATION_VERSION,
      nodes: [{ id: "n1", role: "leader", title: "x", status: "active", modelId: null, pinned: false }],
      currentNodeId: "n1",
      updatedAt: "2026-06-26T00:00:00Z",
      chainPlan: ["architect", "frontend", "runner"],
    };
    const parsed = parseOrchestration(JSON.stringify(v2WithChain));
    expect(parsed!.chainPlan).toEqual(["architect", "frontend", "runner"]);
  });

  it("OrchestrationState 链 plan → 序列化 → 反序列化 → chainPlan 保留（落库往返）", () => {
    const state = resolveOrchestration(plan(), allModels, null, undefined, fixedNow);
    const withChain = withChainPlan(state, ["architect", "frontend", "runner"]);
    const json = serializeOrchestration(withChain);
    const parsed = parseOrchestration(json);
    expect(parsed!.chainPlan).toEqual(["architect", "frontend", "runner"]);
  });
});

describe("deriveChainProgress（阶段 E2b：进度条单一来源）", () => {
  it("无 chainPlan → 8 角色全 pending（leader=start）", () => {
    const p = deriveChainProgress({ chainPlan: [], executedRoles: [], skippedRoles: [], abortedRole: null });
    expect(p.states.leader).toBe("start");
    expect(p.states.architect).toBe("pending");
    expect(p.states.frontend).toBe("pending");
    expect(p.states.security).toBe("pending");
    expect(p.totalCount).toBe(0);
    expect(p.doneCount).toBe(0);
    expect(p.executingRole).toBeNull();
  });

  it("chainPlan=[architect,frontend] 无 executedRoles → architect=executing, frontend=pending", () => {
    const p = deriveChainProgress({ chainPlan: ["architect", "frontend"], executedRoles: [], skippedRoles: [], abortedRole: null });
    expect(p.states.leader).toBe("start");
    expect(p.states.architect).toBe("executing");
    expect(p.states.frontend).toBe("pending");
    expect(p.states.backend).toBe("pending"); // 不在 chainPlan
    expect(p.executingRole).toBe("architect");
    expect(p.totalCount).toBe(2);
  });

  it("executedRoles=[architect] → architect=done, frontend=executing", () => {
    const p = deriveChainProgress({ chainPlan: ["architect", "frontend"], executedRoles: ["architect"], skippedRoles: [], abortedRole: null });
    expect(p.states.architect).toBe("done");
    expect(p.states.frontend).toBe("executing");
    expect(p.doneCount).toBe(1);
    expect(p.executingRole).toBe("frontend");
  });

  it("skippedRoles=[architect] → architect=skipped, frontend=executing", () => {
    const p = deriveChainProgress({ chainPlan: ["architect", "frontend"], executedRoles: [], skippedRoles: ["architect"], abortedRole: null });
    expect(p.states.architect).toBe("skipped");
    expect(p.states.frontend).toBe("executing");
  });

  it("abortedRole=frontend → frontend=aborted（不再 executing）", () => {
    const p = deriveChainProgress({ chainPlan: ["architect", "frontend"], executedRoles: ["architect"], skippedRoles: [], abortedRole: "frontend" });
    expect(p.states.architect).toBe("done");
    expect(p.states.frontend).toBe("aborted");
    expect(p.executingRole).toBeNull(); // 中止后无 executing
  });

  it("leader 永远 = start（不参与 chainPlan）", () => {
    const p = deriveChainProgress({ chainPlan: ["leader"], executedRoles: [], skippedRoles: [], abortedRole: null });
    // leader 即使出现在 chainPlan（实际不会，computeChain 已过滤），仍标 start
    expect(p.states.leader).toBe("start");
  });

  it("完整跑完 → 全 done，doneCount = totalCount", () => {
    const p = deriveChainProgress({ chainPlan: ["architect", "frontend", "runner"], executedRoles: ["architect", "frontend", "runner"], skippedRoles: [], abortedRole: null });
    expect(p.states.architect).toBe("done");
    expect(p.states.frontend).toBe("done");
    expect(p.states.runner).toBe("done");
    expect(p.doneCount).toBe(3);
    expect(p.totalCount).toBe(3);
    expect(p.executingRole).toBeNull();
  });

  it("混合：done + skipped + pending，链中第一个未处理的 executing", () => {
    const p = deriveChainProgress({ chainPlan: ["architect", "frontend", "tester"], executedRoles: ["architect"], skippedRoles: ["frontend"], abortedRole: null });
    expect(p.states.architect).toBe("done");
    expect(p.states.frontend).toBe("skipped");
    expect(p.states.tester).toBe("executing"); // 跳过 frontend 后，下一个 tester 变成 executing
  });
});