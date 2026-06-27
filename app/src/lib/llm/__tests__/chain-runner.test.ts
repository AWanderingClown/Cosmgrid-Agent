// 阶段 E2a — chain-runner 单测：纯函数 + runChain 集成
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock streamWithFallback（chain-runner 唯一外部依赖）
const streamWithFallbackMock = vi.fn();
vi.mock("../chat-fallback", () => ({
  streamWithFallback: (...args: unknown[]) => streamWithFallbackMock(...args),
  // pickBestModelWithPerformance 在 chat-fallback 之外；E2a 不 mock 它
}));

import {
  buildChainContext,
  buildChainMessages,
  pickChainRoleModel,
  runChain,
} from "../chain-runner";
import type { ModelEndpoint, StreamUsage } from "../chat-fallback";
import type { RoleId } from "../orchestrator";

// Mock 一个 ModelEndpoint 工厂
function endpoint(modelId: string, modelName: string): ModelEndpoint {
  return {
    modelId,
    modelName,
    providerType: "openai-compatible",
    apiKey: "sk-test",
    apiCredentialId: "cred-test",
    providerId: "prov-test",
    baseUrl: "https://api.test/v1",
    displayLabel: modelName,
  };
}

const fixedEndpoints: ModelEndpoint[] = [
  endpoint("m-flagship", "o1-flagship"),
  endpoint("m-coder", "claude-sonnet-4-6"),
  endpoint("m-cheap", "claude-haiku-4-5"),
];

const fixedBindings = new Map<RoleId, string>();

function fixedController(): AbortController {
  return new AbortController();
}

describe("buildChainContext（纯函数）", () => {
  it("空 executedRoles → previousOutputs/ArtifactTitles 都空", () => {
    const ctx = buildChainContext({ userTask: "做个待办", executedRoles: [] });
    expect(ctx.userTask).toBe("做个待办");
    expect(ctx.previousOutputs).toEqual([]);
    expect(ctx.previousArtifactTitles).toEqual([]);
  });

  it("1 个角色 → 1 个 previousOutput", () => {
    const ctx = buildChainContext({
      userTask: "做个待办",
      executedRoles: [{ role: "architect", content: "出方案了" }],
    });
    expect(ctx.previousOutputs).toEqual([{ role: "architect", summary: "出方案了" }]);
  });

  it("summary 截断到 SUMMARY_MAX_CHARS（500）+ '…'", () => {
    const longContent = "x".repeat(800);
    const ctx = buildChainContext({
      userTask: "x",
      executedRoles: [{ role: "architect", content: longContent }],
    });
    expect(ctx.previousOutputs[0]!.summary.length).toBe(501); // 500 + "…"
    expect(ctx.previousOutputs[0]!.summary.endsWith("…")).toBe(true);
  });

  it("userTask 透传不修改", () => {
    const ctx = buildChainContext({ userTask: "原始问题\n多行\n内容", executedRoles: [] });
    expect(ctx.userTask).toBe("原始问题\n多行\n内容");
  });

  it("roleArtifacts 过滤空 + 截断到 20 个", () => {
    const ctx = buildChainContext({
      userTask: "x",
      executedRoles: [],
      roleArtifacts: {
        architect: ["plan.md", "schema.sql"],
        frontend: [], // 空数组过滤掉
        backend: Array.from({ length: 30 }, (_, i) => `file-${i}.ts`),  // 30 个 → 截断到 20
        // 显式列全 8 角色 key（TS strict Record 要求所有 key）
        leader: [], security: [], runner: [], tester: [], reviewer: [],
      } as Record<RoleId, string[]>,
    });
    expect(ctx.previousArtifactTitles).toHaveLength(2); // frontend 空数组被过滤
    expect(ctx.previousArtifactTitles.find((a) => a.role === "backend")!.titles).toHaveLength(20);
  });
});

describe("buildChainMessages（纯函数）", () => {
  it("返回 1 system + 1 user，无 ChainContext 时不传 previousOutputs/ArtifactTitles", () => {
    const msgs = buildChainMessages("frontend", "做个待办", {
      userTask: "做个待办",
      previousOutputs: [],
      previousArtifactTitles: [],
    }, true);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).toBe("做个待办");
  });

  it("system 提示含该角色 key + ROLE_LABELS（前端工程师）", () => {
    const msgs = buildChainMessages("frontend", "x", {
      userTask: "x",
      previousOutputs: [],
      previousArtifactTitles: [],
    }, true);
    const sys = msgs[0]!.content as string;
    expect(sys).toContain("frontend");
    expect(sys).toContain("前端工程师");
  });

  it("hasTools=true → system 提示'直接调用工具'", () => {
    const msgs = buildChainMessages("frontend", "x", {
      userTask: "x", previousOutputs: [], previousArtifactTitles: [],
    }, true);
    expect(msgs[0]!.content as string).toContain("直接调用工具");
  });

  it("hasTools=false → system 提示'本次你没有可用工具'", () => {
    const msgs = buildChainMessages("leader", "x", {
      userTask: "x", previousOutputs: [], previousArtifactTitles: [],
    }, false);
    expect(msgs[0]!.content as string).toContain("本次你没有可用工具");
  });

  it("有 previousOutputs → system 含上一角色摘要", () => {
    const msgs = buildChainMessages("frontend", "x", {
      userTask: "x",
      previousOutputs: [{ role: "architect", summary: "出方案：用 React + Vite" }],
      previousArtifactTitles: [],
    }, true);
    expect(msgs[0]!.content as string).toContain("出方案：用 React + Vite");
    expect(msgs[0]!.content as string).toContain("架构评审");
  });

  it("有 previousArtifactTitles → system 含工件标题清单（不传全文）", () => {
    const msgs = buildChainMessages("runner", "x", {
      userTask: "x",
      previousOutputs: [],
      previousArtifactTitles: [{ role: "frontend", titles: ["App.tsx", "main.tsx"] }],
    }, true);
    expect(msgs[0]!.content as string).toContain("App.tsx");
    expect(msgs[0]!.content as string).toContain("main.tsx");
  });
});

describe("pickChainRoleModel（纯函数）", () => {
  it("binding 命中 → 用 binding 的模型", () => {
    const bindings = new Map<RoleId, string>([["frontend", "m-flagship"]]);
    const m = pickChainRoleModel("frontend", bindings, fixedEndpoints);
    expect(m?.modelId).toBe("m-flagship");
  });

  it("binding 命中但 modelId 不在 endpoints → fallback pickBestModelWithPerformance", () => {
    const bindings = new Map<RoleId, string>([["frontend", "m-deleted"]]);
    // frontend workRole → coder（claude-sonnet-4-6 在 frontend workRole 上有分数）
    const m = pickChainRoleModel("frontend", bindings, fixedEndpoints);
    expect(m?.modelId).toBe("m-coder"); // fallback 自动选
  });

  it("无 binding → fallback pickBestModelWithPerformance 按 ROLE_TO_WORK_ROLE", () => {
    const m = pickChainRoleModel("tester", fixedBindings, fixedEndpoints);
    // tester → testing workRole → cheap（claude-haiku-4-5）
    expect(m?.modelId).toBe("m-cheap");
  });

  it("endpoints 空 → 返 null", () => {
    expect(pickChainRoleModel("frontend", fixedBindings, [])).toBeNull();
  });
});

describe("runChain（集成）", () => {
  beforeEach(() => streamWithFallbackMock.mockReset());

  it("chain=[] → 立即返 { stoppedAt: null, executedRoles: [], skippedRoles: [] }", async () => {
    const result = await runChain({
      chain: [],
      userTask: "x",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: undefined,
      conversationId: null,
    });
    expect(result.stoppedAt).toBeNull();
    expect(result.executedRoles).toEqual([]);
    expect(result.skippedRoles).toEqual([]);
    expect(streamWithFallbackMock).not.toHaveBeenCalled();
  });

  it("chain=['architect', 'frontend', 'runner'] → 完整跑完，3 次 streamWithFallback", async () => {
    streamWithFallbackMock.mockResolvedValue({ usedModelId: "m-coder", switched: false });

    const result = await runChain({
      chain: ["architect", "frontend", "runner"],
      userTask: "做个待办",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: undefined,
      conversationId: "conv-1",
    });

    expect(result.stoppedAt).toBeNull();
    expect(result.executedRoles.map((r) => r.role)).toEqual(["architect", "frontend", "runner"]);
    expect(result.executedRoles.every((r) => r.content === "")).toBe(true); // mock 没真发 delta
    expect(streamWithFallbackMock).toHaveBeenCalledTimes(3);
  });

  it("★ 必查：每跳 streamWithFallback 都接收 tools（命脉：tools 必传）", async () => {
    streamWithFallbackMock.mockResolvedValue({ usedModelId: "m-coder", switched: false });

    const tools = { read: { description: "read file" } } as unknown as Parameters<typeof import("../tools").buildAiSdkTools>[1] extends infer T ? T : never;
    // 简化：tools 形状不强校验，关键是验证 streamWithFallback 第 4 参数含 tools
    await runChain({
      chain: ["architect", "frontend"],
      userTask: "x",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: tools as never,
      conversationId: "conv-1",
    });

    expect(streamWithFallbackMock).toHaveBeenCalledTimes(2);
    for (const call of streamWithFallbackMock.mock.calls) {
      const opts = call[3] as { tools?: unknown };
      expect(opts.tools).toBe(tools); // ★ 关键：tools 真的传给了 streamWithFallback
    }
  });

  it("★ 必查：tools=undefined（无工作区）→ streamWithFallback 不传 tools 字段（不能误传空对象）", async () => {
    streamWithFallbackMock.mockResolvedValue({ usedModelId: "m-coder", switched: false });

    await runChain({
      chain: ["frontend"],
      userTask: "x",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: undefined,
      conversationId: null,
    });

    expect(streamWithFallbackMock).toHaveBeenCalledTimes(1);
    const opts = streamWithFallbackMock.mock.calls[0]![3] as { tools?: unknown };
    expect(opts.tools).toBeUndefined();
  });

  it("controller.abort 在第 2 跳前 → stoppedAt = chain[1]，executedRoles 只有 1 项", async () => {
    streamWithFallbackMock.mockResolvedValue({ usedModelId: "m-coder", switched: false });

    const controller = fixedController();
    let abortAfterFirst = false;
    streamWithFallbackMock.mockImplementation(async () => {
      if (!abortAfterFirst) {
        abortAfterFirst = true;
      } else {
        controller.abort(); // 第 2 次调用前 abort
      }
      return { usedModelId: "m-coder", switched: false };
    });

    const result = await runChain({
      chain: ["architect", "frontend", "runner"],
      userTask: "x",
      controller,
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: undefined,
      conversationId: null,
    });

    expect(result.stoppedAt).toBe("frontend"); // 第 2 跳被中止
    expect(result.executedRoles).toHaveLength(1);
    expect(result.executedRoles[0]!.role).toBe("architect");
  });

  it("某跳无模型可用 → 跳过该跳，继续下一跳（skippedRoles 含该角色）", async () => {
    streamWithFallbackMock.mockResolvedValue({ usedModelId: "m-coder", switched: false });

    // 强制 pickChainRoleModel 返 null：bindings 给一个不存在的 modelId + endpoints 给一个空
    // 用 reviewer 这种 niche role 配 binding 删了的模型
    const bindings = new Map<RoleId, string>([["reviewer", "m-deleted"]]);
    // 但 endpoints 只有 m-deleted，pickBestModel 走 fallback 可能也返 null
    // 简化：让 endpoints 为空来强制 null
    const result = await runChain({
      chain: ["reviewer"],
      userTask: "x",
      controller: fixedController(),
      bindings,
      models: [], // 空 → pickChainRoleModel 返 null → 跳过
      tools: undefined,
      conversationId: null,
    });

    expect(result.skippedRoles).toContain("reviewer");
    expect(result.executedRoles).toHaveLength(0);
    expect(streamWithFallbackMock).not.toHaveBeenCalled();
  });

  it("★ 必查：nudge 套进 chain 每跳——toolCallCount=0 + 意图命中 → 重答一次（attempt=1）", async () => {
    let callCount = 0;
    const fakeSwf = async (
      _models: unknown, _messages: unknown,
      callbacks: { onUsage?: (u: StreamUsage, m: ModelEndpoint, fr: string) => void; onDelta?: (delta: string) => void; },
      _options: unknown,
    ) => {
      callCount++;
      if (callCount === 1) {
        callbacks.onUsage?.({ inputTokens: 10, outputTokens: 20, toolCallCount: 0 }, fixedEndpoints[1]!, "stop");
        callbacks.onDelta?.("我先去看一下 foo.ts 然后改一下");
      } else {
        callbacks.onUsage?.({ inputTokens: 15, outputTokens: 25, toolCallCount: 1 }, fixedEndpoints[1]!, "stop");
        callbacks.onDelta?.("已读完并修改 foo.ts");
      }
      return { usedModelId: "m-coder", switched: false };
    };

    const result = await runChain({
      chain: ["frontend"],
      userTask: "改一下 foo.ts",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: { read: {} } as never,
      conversationId: "conv-1",
      _deps: { streamWithFallback: fakeSwf as never },
    });

    expect(callCount).toBe(2);
    expect(result.executedRoles).toHaveLength(1);
    expect(result.executedRoles[0]!.role).toBe("frontend");
  });

  it("★ 必查：nudge 至多 1 次（attempt < MAX_HARNESS_RETRY 守门）", async () => {
    let callCount = 0;
    const fakeSwf = async (
      _models: unknown, _messages: unknown,
      callbacks: { onUsage?: (u: StreamUsage, m: ModelEndpoint, fr: string) => void; onDelta?: (delta: string) => void; },
      _options: unknown,
    ) => {
      callCount++;
      // 两次都触发 nudge 条件（toolCallCount=0 + 意图命中）
      callbacks.onUsage?.({ inputTokens: 10, outputTokens: 20, toolCallCount: 0 }, fixedEndpoints[1]!, "stop");
      callbacks.onDelta?.("我先去看看 foo.ts");
      return { usedModelId: "m-coder", switched: false };
    };

    await runChain({
      chain: ["frontend"],
      userTask: "改 foo.ts",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: { read: {} } as never,
      conversationId: "conv-1",
      _deps: { streamWithFallback: fakeSwf as never },
    });

    expect(callCount).toBe(2); // 1 次 + 1 次 nudge = 2，不超过 2
  });

  it("tools=undefined 时不触发 nudge（无工具任务不会'光说不做'）", async () => {
    let callCount = 0;
    const fakeSwf = async (
      _models: unknown, _messages: unknown,
      callbacks: { onUsage?: (u: StreamUsage, m: ModelEndpoint, fr: string) => void; onDelta?: (delta: string) => void; },
      _options: unknown,
    ) => {
      callCount++;
      callbacks.onUsage?.({ inputTokens: 10, outputTokens: 20, toolCallCount: 0 }, fixedEndpoints[1]!, "stop");
      callbacks.onDelta?.("我先去看看 foo.ts");
      return { usedModelId: "m-coder", switched: false };
    };

    await runChain({
      chain: ["frontend"],
      userTask: "改 foo.ts",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: undefined,
      conversationId: "conv-1",
      _deps: { streamWithFallback: fakeSwf as never },
    });

    expect(callCount).toBe(1); // 不重答
  });

  it("★ 必查：leader 不在 chain 里（computeChain 已过滤，但 runChain 应不主动加 leader）", async () => {
    streamWithFallbackMock.mockResolvedValue({ usedModelId: "m-coder", switched: false });
    const onRoleStart = vi.fn();

    await runChain({
      chain: ["architect", "frontend"], // 不含 leader
      userTask: "x",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: undefined,
      conversationId: null,
      callbacks: { onRoleStart },
    });

    // onRoleStart 只被 architect + frontend 触发（不含 leader）
    const roles = onRoleStart.mock.calls.map((c) => c[0]);
    expect(roles).toEqual(["architect", "frontend"]);
    expect(roles).not.toContain("leader");
  });

  it("onChainStart 在循环开头调一次，onChainDone 在循环结束调一次", async () => {
    streamWithFallbackMock.mockResolvedValue({ usedModelId: "m-coder", switched: false });
    const onChainStart = vi.fn();
    const onChainDone = vi.fn();

    await runChain({
      chain: ["architect", "frontend"],
      userTask: "x",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: undefined,
      conversationId: null,
      callbacks: { onChainStart, onChainDone },
    });

    expect(onChainStart).toHaveBeenCalledTimes(1);
    expect(onChainStart).toHaveBeenCalledWith(2);
    expect(onChainDone).toHaveBeenCalledTimes(1);
  });

  it("streamWithFallback 抛错 → 立即停 stoppedAt = role，executedRoles 含前面的角色", async () => {
    let count = 0;
    streamWithFallbackMock.mockImplementation(async () => {
      count++;
      if (count === 2) throw new Error("API rate limit");
      return { usedModelId: "m-coder", switched: false };
    });

    const result = await runChain({
      chain: ["architect", "frontend", "runner"],
      userTask: "x",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: undefined,
      conversationId: null,
    });

    expect(result.stoppedAt).toBe("frontend");
    expect(result.executedRoles).toHaveLength(1);
    expect(result.executedRoles[0]!.role).toBe("architect");
  });

  it("conversationId / projectId 透传给 streamWithFallback（让 UsageEvent / tool_executions 关联）", async () => {
    streamWithFallbackMock.mockResolvedValue({ usedModelId: "m-coder", switched: false });

    await runChain({
      chain: ["frontend"],
      userTask: "x",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: { read: {} } as never,
      conversationId: "conv-99",
      projectId: "proj-99",
    });

    const opts = streamWithFallbackMock.mock.calls[0]![3] as { conversationId?: string; projectId?: string };
    expect(opts.conversationId).toBe("conv-99");
    expect(opts.projectId).toBe("proj-99");
  });
});

describe("阶段 F1 H1：runChain 每跳 actorRole 透传守门（review F1-3 必查）", () => {
  beforeEach(() => streamWithFallbackMock.mockReset());
  streamWithFallbackMock.mockResolvedValue({ usedModelId: "m-coder", switched: false });

  it("★ 每跳 streamWithFallback 第 4 参数含 actorRole=role（架构/前端/Runtime 三跳分别传不同 role）", async () => {
    await runChain({
      chain: ["architect", "frontend", "runner"],
      userTask: "x",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: undefined,
      conversationId: null,
    });

    expect(streamWithFallbackMock).toHaveBeenCalledTimes(3);
    // 第 1 跳：architect
    const opts1 = streamWithFallbackMock.mock.calls[0]![3] as { actorRole?: string };
    expect(opts1.actorRole).toBe("architect");
    // 第 2 跳：frontend
    const opts2 = streamWithFallbackMock.mock.calls[1]![3] as { actorRole?: string };
    expect(opts2.actorRole).toBe("frontend");
    // 第 3 跳：runner
    const opts3 = streamWithFallbackMock.mock.calls[2]![3] as { actorRole?: string };
    expect(opts3.actorRole).toBe("runner");
  });

  it("★ nudge 重答那一跳 actorRole 同原 role（同一角色的二次尝试，统计上算 1 个 actor 的 2 次调用）", async () => {
    let callCount = 0;
    const seenActorRoles: string[] = [];
    const fakeSwf = async (
      _models: unknown, _messages: unknown,
      callbacks: { onUsage?: (u: StreamUsage, m: ModelEndpoint, fr: string) => void; onDelta?: (delta: string) => void; },
      options: { actorRole?: string },
    ) => {
      callCount++;
      seenActorRoles.push(options.actorRole ?? "");
      if (callCount === 1) {
        // 第 1 次触发 nudge（finishReason=stop + toolCallCount=0 + 意图命中）
        callbacks.onUsage?.({ inputTokens: 10, outputTokens: 20, toolCallCount: 0 }, fixedEndpoints[1]!, "stop");
        callbacks.onDelta?.("我先去看看 foo.ts");
      } else {
        // nudge 重答：这次真调工具
        callbacks.onUsage?.({ inputTokens: 15, outputTokens: 25, toolCallCount: 1 }, fixedEndpoints[1]!, "stop");
        callbacks.onDelta?.("已读 + 修改");
      }
      return { usedModelId: "m-coder", switched: false };
    };

    await runChain({
      chain: ["frontend"],
      userTask: "改 foo.ts",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: { read: {} } as never,
      conversationId: "conv-1",
      _deps: { streamWithFallback: fakeSwf as never },
    });

    // 两次 actorRole 都是 'frontend'（不是 leader 也不是 architect）
    expect(callCount).toBe(2); // 1 次 + 1 次 nudge
    expect(seenActorRoles).toEqual(["frontend", "frontend"]);
  });

  it("抛错那跳 actorRole 仍传正确值（review F1-3：抛错前 streamWithFallback 已记录 UsageEvent 含 actorRole）", async () => {
    let callCount = 0;
    streamWithFallbackMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error("API rate limit");
      return { usedModelId: "m-coder", switched: false };
    });

    await runChain({
      chain: ["architect", "frontend"],
      userTask: "x",
      controller: fixedController(),
      bindings: fixedBindings,
      models: fixedEndpoints,
      tools: undefined,
      conversationId: null,
    });

    // 直接读 mock.calls 验证（不依赖 mockImplementation 内的局部 count）
    expect(streamWithFallbackMock).toHaveBeenCalledTimes(2);
    const opts1 = streamWithFallbackMock.mock.calls[0]![3] as { actorRole?: string };
    const opts2 = streamWithFallbackMock.mock.calls[1]![3] as { actorRole?: string };
    expect(opts1.actorRole).toBe("architect");
    expect(opts2.actorRole).toBe("frontend");
  });
});