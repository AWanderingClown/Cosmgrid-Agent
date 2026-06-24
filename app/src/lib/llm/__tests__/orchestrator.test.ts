// orchestrator 单测：LLM 节点规划（mock）+ 纯函数模型分配/接管/diff
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
  NODE_KINDS,
  type OrchestrationPlan,
  type OrchestrationState,
  type AssignableModel,
} from "../orchestrator";
import type { LanguageModel } from "../provider-factory";

const fakeModel = {} as LanguageModel;
const fixedNow = () => "2026-06-23T00:00:00.000Z";

/** 造一个可评分模型；name 决定档位，workRoles 决定它擅长的角色 */
function model(id: string, name: string, workRoles: string[] = []): AssignableModel {
  return { id, name, capabilityScore: null, workRoles: JSON.stringify(workRoles) };
}

// 三个模型：强模型(规划/审查)、写码模型、便宜模型(测试)
const flagship = model("m-flagship", "claude-opus-4-8", ["planning", "review"]);
const coder = model("m-coder", "claude-sonnet-4-6", ["backend", "frontend"]);
const cheap = model("m-cheap", "claude-haiku-4-5", ["testing"]);
const allModels = [flagship, coder, cheap];

function plan(over: Partial<OrchestrationPlan> = {}): OrchestrationPlan {
  return {
    currentNodeKind: "planning",
    nodes: [{ kind: "planning", title: "规划方案", status: "active" }],
    reason: "用户刚提出需求",
    ...over,
  };
}

describe("planNodes（LLM 规划，mock generateObject）", () => {
  beforeEach(() => generateObjectMock.mockReset());

  it("把对话历史与已有节点图都喂进 prompt，返回结构化规划", async () => {
    const fakePlan = plan({
      nodes: [
        { kind: "planning", title: "规划方案", status: "done" },
        { kind: "coding", title: "写 TodoList.tsx", status: "active" },
      ],
      currentNodeKind: "coding",
    });
    generateObjectMock.mockResolvedValue({ object: fakePlan });

    const prev: OrchestrationState = {
      version: 1,
      nodes: [{ id: "p1", kind: "planning", title: "规划方案", status: "active", modelId: "m-flagship", pinned: false }],
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
    expect(args.prompt).toContain("规划方案"); // 已有节点图被带入（滚动规划）
  });

  it("空历史也能调用（prompt 含占位）", async () => {
    generateObjectMock.mockResolvedValue({ object: plan() });
    await planNodes(fakeModel, []);
    const args = generateObjectMock.mock.calls[0]![0] as { prompt: string };
    expect(args.prompt).toContain("还没有任何内容");
    expect(args.prompt).toContain("还没有规划过节点");
  });
});

describe("resolveOrchestration（纯函数：定模型）", () => {
  it("按节点角色自动选最合适的模型", () => {
    const p = plan({
      nodes: [
        { kind: "planning", title: "规划", status: "done" },
        { kind: "coding", title: "写码", status: "active" },
        { kind: "testing", title: "测试", status: "planned" },
      ],
      currentNodeKind: "coding",
    });
    const state = resolveOrchestration(p, allModels, null, fixedNow);

    const byKind = Object.fromEntries(state.nodes.map((n) => [n.kind, n.modelId]));
    expect(byKind.planning).toBe("m-flagship"); // 规划 → 强模型
    expect(byKind.coding).toBe("m-coder"); // 写码 → 写码模型
    expect(byKind.testing).toBe("m-cheap"); // 测试 → 便宜模型
  });

  it("currentNodeId 指向 currentNodeKind 的 active 节点", () => {
    const p = plan({
      nodes: [
        { kind: "planning", title: "规划", status: "done" },
        { kind: "coding", title: "写码", status: "active" },
      ],
      currentNodeKind: "coding",
    });
    const state = resolveOrchestration(p, allModels, null, fixedNow);
    expect(currentNode(state)?.kind).toBe("coding");
  });

  it("继承旧节点的 id（按 kind 匹配），保住稳定身份", () => {
    const prev = resolveOrchestration(
      plan({ nodes: [{ kind: "planning", title: "规划", status: "active" }], currentNodeKind: "planning" }),
      allModels,
      null,
      fixedNow,
    );
    const planningId = prev.nodes[0]!.id;

    const next = resolveOrchestration(
      plan({
        nodes: [
          { kind: "planning", title: "规划", status: "done" },
          { kind: "coding", title: "写码", status: "active" },
        ],
        currentNodeKind: "coding",
      }),
      allModels,
      prev,
      fixedNow,
    );
    expect(next.nodes.find((n) => n.kind === "planning")!.id).toBe(planningId);
  });

  it("用户钉住的节点不被自动覆盖模型", () => {
    let prev = resolveOrchestration(
      plan({ nodes: [{ kind: "coding", title: "写码", status: "active" }], currentNodeKind: "coding" }),
      allModels,
      null,
      fixedNow,
    );
    // 用户手动把 coding 节点切到 flagship 并钉住
    prev = pinModelToCurrentNode(prev, "m-flagship", fixedNow);

    // 再跑一次编排（仍含 coding 节点）→ 不该把它自动换回 coder
    const next = resolveOrchestration(
      plan({ nodes: [{ kind: "coding", title: "写码", status: "active" }], currentNodeKind: "coding" }),
      allModels,
      prev,
      fixedNow,
    );
    const codingNode = next.nodes.find((n) => n.kind === "coding")!;
    expect(codingNode.modelId).toBe("m-flagship");
    expect(codingNode.pinned).toBe(true);
  });

  it("没有可用模型时 modelId 为 null（不崩）", () => {
    const state = resolveOrchestration(plan(), [], null, fixedNow);
    expect(state.nodes[0]!.modelId).toBeNull();
  });
});

describe("pinModelToCurrentNode", () => {
  it("只钉当前节点，其余不动（不可变）", () => {
    const state = resolveOrchestration(
      plan({
        nodes: [
          { kind: "planning", title: "规划", status: "done" },
          { kind: "coding", title: "写码", status: "active" },
        ],
        currentNodeKind: "coding",
      }),
      allModels,
      null,
      fixedNow,
    );
    const pinned = pinModelToCurrentNode(state, "m-flagship", fixedNow);
    expect(pinned).not.toBe(state); // 新对象
    const coding = pinned.nodes.find((n) => n.kind === "coding")!;
    const planning = pinned.nodes.find((n) => n.kind === "planning")!;
    expect(coding.modelId).toBe("m-flagship");
    expect(coding.pinned).toBe(true);
    expect(planning.pinned).toBe(false);
  });
});

describe("pinModelToNode（提前给任意节点指定模型）", () => {
  it("能钉住还没轮到的 planned 节点，且不影响当前节点", () => {
    const state = resolveOrchestration(
      plan({
        nodes: [
          { kind: "coding", title: "写码", status: "active" },
          { kind: "testing", title: "测试", status: "planned" },
        ],
        currentNodeKind: "coding",
      }),
      allModels,
      null,
      fixedNow,
    );
    const testingNode = state.nodes.find((n) => n.kind === "testing")!;
    // 提前把"测试"节点（未轮到）指定成 flagship
    const next = pinModelToNode(state, testingNode.id, "m-flagship", fixedNow);
    const testingAfter = next.nodes.find((n) => n.kind === "testing")!;
    const codingAfter = next.nodes.find((n) => n.kind === "coding")!;
    expect(testingAfter.modelId).toBe("m-flagship");
    expect(testingAfter.pinned).toBe(true);
    expect(codingAfter.pinned).toBe(false); // 当前节点不受影响
  });

  it("钉住的未来节点，轮到时编排不自动覆盖", () => {
    let state = resolveOrchestration(
      plan({
        nodes: [
          { kind: "coding", title: "写码", status: "active" },
          { kind: "testing", title: "测试", status: "planned" },
        ],
        currentNodeKind: "coding",
      }),
      allModels,
      null,
      fixedNow,
    );
    const testingId = state.nodes.find((n) => n.kind === "testing")!.id;
    state = pinModelToNode(state, testingId, "m-flagship", fixedNow);
    // 推进到 testing 节点重算
    const next = resolveOrchestration(
      plan({
        nodes: [
          { kind: "coding", title: "写码", status: "done" },
          { kind: "testing", title: "测试", status: "active" },
        ],
        currentNodeKind: "testing",
      }),
      allModels,
      state,
      fixedNow,
    );
    expect(next.nodes.find((n) => n.kind === "testing")!.modelId).toBe("m-flagship"); // 没被自动换回 cheap
  });
});

describe("diffOrchestration（该不该切+写回执）", () => {
  const s1 = resolveOrchestration(
    plan({ nodes: [{ kind: "planning", title: "规划", status: "active" }], currentNodeKind: "planning" }),
    allModels,
    null,
    fixedNow,
  );

  it("全新状态算进入节点", () => {
    const d = diffOrchestration(null, s1);
    expect(d.nodeChanged).toBe(true);
    expect(d.node?.kind).toBe("planning");
  });

  it("进入新节点 → nodeChanged + modelChanged", () => {
    const s2 = resolveOrchestration(
      plan({
        nodes: [
          { kind: "planning", title: "规划", status: "done" },
          { kind: "coding", title: "写码", status: "active" },
        ],
        currentNodeKind: "coding",
      }),
      allModels,
      s1,
      fixedNow,
    );
    const d = diffOrchestration(s1, s2);
    expect(d.nodeChanged).toBe(true);
    expect(d.modelChanged).toBe(true); // flagship → coder
    expect(d.node?.kind).toBe("coding");
    expect(d.prevModelId).toBe("m-flagship");
  });

  it("同一节点重算、模型没变 → 不切不写回执", () => {
    const d = diffOrchestration(s1, s1);
    expect(d.nodeChanged).toBe(false);
    expect(d.modelChanged).toBe(false);
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

describe("NODE_KINDS 常量", () => {
  it("覆盖五种工作节点", () => {
    expect(NODE_KINDS).toEqual(["planning", "coding", "testing", "review", "chat"]);
  });
});
