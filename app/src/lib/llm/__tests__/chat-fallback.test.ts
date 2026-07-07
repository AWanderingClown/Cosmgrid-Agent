// chat-fallback 单元测试（v0.4.1 重构版：models 数组 + SwitchReason + 内置 recordUsageEvent）
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamText: vi.fn(),
}));

vi.mock("ai", () => ({ streamText: mocks.streamText, stepCountIs: (n: number) => n }));
// provider-factory 直接 mock 掉（不再需要验证 getLanguageModel 内部）
vi.mock("../provider-factory", () => ({
  getLanguageModel: vi.fn((type: string) => ({ __mock: true, type })),
}));
// recordUsageEvent mock 掉（隔离 chat-fallback 的内置 record 行为）
vi.mock("../usage-tracker", () => ({
  recordUsageEvent: vi.fn(),
}));

import {
  streamWithFallback,
  toModelEndpoint,
  type ModelEndpoint,
  type StreamCallbacks,
  type SwitchReason,
} from "../chat-fallback";
import { _resetCooldowns, isInCooldown, markModelFailed } from "../model-cooldown";
import { recordUsageEvent } from "../usage-tracker";

const primary: ModelEndpoint = {
  modelId: "m-primary",
  modelName: "primary-model",
  providerType: "anthropic",
  providerId: "prov-anthropic",
  apiCredentialId: "cred-anthropic",
  apiKey: "sk-test-primary",
  baseUrl: "https://api.anthropic.com",
  displayLabel: "Primary",
};

const fallback: ModelEndpoint = {
  modelId: "m-fallback",
  modelName: "fallback-model",
  providerType: "openai",
  providerId: "prov-openai",
  apiCredentialId: "cred-openai",
  apiKey: "sk-test-fallback",
  baseUrl: "https://api.openai.com",
  displayLabel: "Fallback",
};

beforeEach(() => {
  _resetCooldowns();
  mocks.streamText.mockReset();
  vi.mocked(recordUsageEvent).mockReset();
});

function makeSuccessStream(
  deltas: string[],
  usage = { inputTokens: 10, outputTokens: 5 },
  finishReason = "stop",
) {
  return {
    textStream: (async function* () {
      for (const d of deltas) yield d;
    })(),
    usage: Promise.resolve(usage),
    finishReason: Promise.resolve(finishReason),
  };
}

function makeFailingStream(error: unknown) {
  return {
    textStream: (async function* () {
      throw error;
    })(),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve(undefined),
  };
}

function makePartialFailingStream(deltas: string[], error: unknown) {
  return {
    textStream: (async function* () {
      for (const d of deltas) yield d;
      throw error;
    })(),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve(undefined),
  };
}

describe("streamWithFallback - 主模型正常", () => {
  it("主模型成功时不切 fallback", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["Hi", " there"]));

    const deltas: string[] = [];
    const switched: Array<unknown> = [];
    const usages: Array<{ mid: string; reason: string }> = [];
    const audits: Array<unknown> = [];
    const cbs: StreamCallbacks = {
      onDelta: (d) => deltas.push(d),
      onSwitched: (f, t, r) => switched.push({ from: f.modelId, to: t.modelId, r }),
      onUsage: (_u, m, r) => usages.push({ mid: m.modelId, reason: r }),
      onInvocationAudit: (event) => audits.push(event),
    };

    const result = await streamWithFallback([primary, fallback], [{ role: "user", content: "hi" }], cbs);
    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(deltas.join("")).toBe("Hi there");
    expect(switched).toEqual([]);
    expect(usages).toEqual([{ mid: "m-primary", reason: "stop" }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      modelId: "m-primary",
      providerType: "anthropic",
      providerKind: "api",
      status: "success",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, toolCallCount: 0 },
    });
  });

  it("主模型成功时调用一次 streamText（不调 fallback）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary, fallback], [{ role: "user", content: "x" }], cbs);
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
  });
});

describe("阶段 F1 H2：actorRole 透传到 recordUsageEvent（review F1-1/-7）", () => {
  beforeEach(() => {
    mocks.streamText.mockReset();
    vi.mocked(recordUsageEvent).mockReset();
    _resetCooldowns();
  });

  it("actorRole='leader' → recordUsageEvent 入参含 roleKind='leader'（ChatPage 主对话场景）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["hi"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs, {
      actorRole: "leader",
    });
    expect(vi.mocked(recordUsageEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordUsageEvent).mock.calls[0]![0]).toMatchObject({ roleKind: "leader" });
  });

  it("actorRole=undefined → recordUsageEvent 入参不设 roleKind 字段（让 db 层 ?? null 兜底 → 落 NULL → 聚合'未分类'组）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["hi"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs);
    // 不传 options.actorRole → spread 守门（line 301 ...(params.roleKind !== undefined ? { roleKind } : {})）
    // → 入参对象上不该有 roleKind 字段
    const calledArg = vi.mocked(recordUsageEvent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect("roleKind" in calledArg).toBe(false);
  });

  it("actorRole=null → recordUsageEvent 入参 roleKind=null（明确归'未分类'组，区别于 undefined）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["hi"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs, {
      actorRole: null,
    });
    expect(vi.mocked(recordUsageEvent)).toHaveBeenCalledTimes(1);
    const calledArg = vi.mocked(recordUsageEvent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(calledArg.roleKind).toBeNull();
  });

  it("actorRole='stage' → recordUsageEvent 入参含 roleKind='stage'（ProjectDetailPage stage 路径）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["hi"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs, {
      actorRole: "stage",
    });
    expect(vi.mocked(recordUsageEvent).mock.calls[0]![0]).toMatchObject({ roleKind: "stage" });
  });
});

describe("streamWithFallback - 主模型失败分类", () => {
  it.each<[number, string, boolean]>([
    [401, "auth_invalid", true],
    [403, "auth_forbidden", true],
    [404, "model_not_found", true],
    [429, "rate_limit", true],
    [500, "server_error", true],
    [413, "context_overflow", false],
  ])("HTTP %i → category 切=%s, shouldFallback=%s", async (status, label, shouldSwitch) => {
    mocks.streamText.mockReturnValueOnce(
      makeFailingStream({ statusCode: status, message: `HTTP ${status}` }),
    );
    if (shouldSwitch) {
      mocks.streamText.mockReturnValueOnce(makeSuccessStream(["from fallback"]));
    }

    const switched: Array<{ from: string; to: string; reason: SwitchReason }> = [];
    const deltas: string[] = [];
    const audits: Array<unknown> = [];
    const cbs: StreamCallbacks = {
      onDelta: (d) => deltas.push(d),
      onSwitched: (f, t, r) => switched.push({ from: f.modelId, to: t.modelId, reason: r }),
      onInvocationAudit: (event) => audits.push(event),
    };

    if (shouldSwitch) {
      const result = await streamWithFallback(
        [primary, fallback],
        [{ role: "user", content: "x" }],
        cbs,
      );
      expect(result.switched).toBe(true);
      expect(result.usedModelId).toBe("m-fallback");
      expect(switched).toHaveLength(1);
      expect(switched[0]!.reason).toEqual({ kind: "error", category: label });
      expect(deltas.join("")).toBe("from fallback");
      expect(mocks.streamText).toHaveBeenCalledTimes(2);
      expect(audits.map((event) => (event as { status: string }).status)).toEqual(["error", "success"]);
      expect(audits[0]).toMatchObject({
        modelId: "m-primary",
        providerKind: "api",
        status: "error",
        errorCategory: label,
      });
    } else {
      await expect(
        streamWithFallback([primary, fallback], [{ role: "user", content: "x" }], cbs),
      ).rejects.toBeDefined();
      expect(switched).toEqual([]);
      expect(mocks.streamText).toHaveBeenCalledTimes(1);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        modelId: "m-primary",
        status: "error",
        errorCategory: label,
      });
    }
  });
});

describe("streamWithFallback - 网络/超时错误", () => {
  it.each<[string, Error]>([
    ["timeout", new Error("Request timed out")],
    ["ECONNREFUSED", new Error("connect ECONNREFUSED")],
  ])("%s → 切 fallback", async (_label, err) => {
    mocks.streamText.mockReturnValueOnce(makeFailingStream(err));
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));

    const cbs: StreamCallbacks = { onDelta: () => {} };
    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
    );
    expect(result.switched).toBe(true);
    expect(result.usedModelId).toBe("m-fallback");
  });
});

describe("streamWithFallback - partial 文本 + 不同错误分类的 fallback 行为", () => {
  // 1.1 关键场景：主模型流出部分文本后被服务端拒（429/401/5xx），
  // 必须切 fallback 且把 partial 塞回 + onSwitched category 正确分类
  it.each<[number, string]>([
    [429, "rate_limit"],
    [401, "auth_invalid"],
    [500, "server_error"],
  ])(
    "partial 文本 + HTTP %i → 切 fallback + 上下文带 partial + onSwitched(category=%s)",
    async (status, label) => {
      mocks.streamText.mockReturnValueOnce(
        makePartialFailingStream(["主模型已输出片段。"], {
          statusCode: status,
          message: `HTTP ${status}`,
        }),
      );
      mocks.streamText.mockReturnValueOnce(makeSuccessStream(["fallback 续写。"]));

      const deltas: string[] = [];
      const switched: Array<{ from: string; to: string; reason: SwitchReason }> = [];
      const cbs: StreamCallbacks = {
        onDelta: (d) => deltas.push(d),
        onSwitched: (f, t, r) => switched.push({ from: f.modelId, to: t.modelId, reason: r }),
      };

      const result = await streamWithFallback(
        [primary, fallback],
        [{ role: "user", content: "完整任务" }],
        cbs,
      );

      expect(result).toEqual({ usedModelId: "m-fallback", switched: true });
      expect(deltas.join("")).toBe("主模型已输出片段。fallback 续写。");
      expect(switched).toHaveLength(1);
      expect(switched[0]!.reason).toEqual({ kind: "error", category: label });
      const fallbackCall = mocks.streamText.mock.calls[1]![0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(fallbackCall.messages.some((m) => m.role === "assistant" && m.content === "主模型已输出片段。")).toBe(true);
      expect(fallbackCall.messages.at(-1)?.content).toContain("不要重复已经完成的内容");
    },
  );

  it("链上所有模型 partial 后都失败 → 抛错且 partial 不被吞", async () => {
    mocks.streamText
      .mockReturnValueOnce(makePartialFailingStream(["主模型片段。"], { statusCode: 429, message: "HTTP 429" }))
      .mockReturnValueOnce(makePartialFailingStream(["fallback 片段。"], { statusCode: 429, message: "HTTP 429" }));

    await expect(
      streamWithFallback(
        [primary, fallback],
        [{ role: "user", content: "x" }],
        { onDelta: () => {} },
      ),
    ).rejects.toBeDefined();
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
  });
});

describe("streamWithFallback - 非用户中断自动恢复", () => {
  it("finishReason=length 时自动让同一模型从中断处续写，不把截断当完成", async () => {
    mocks.streamText
      .mockReturnValueOnce(makeSuccessStream(["第一段"], { inputTokens: 10, outputTokens: 20 }, "length"))
      .mockReturnValueOnce(makeSuccessStream(["第二段"], { inputTokens: 5, outputTokens: 10 }, "stop"));

    const deltas: string[] = [];
    const usages: Array<{ reason: string; input: number; output: number }> = [];
    const cbs: StreamCallbacks = {
      onDelta: (d) => deltas.push(d),
      onUsage: (u, _m, reason) => usages.push({ reason, input: u.inputTokens, output: u.outputTokens }),
    };

    const result = await streamWithFallback([primary], [{ role: "user", content: "写完整方案" }], cbs);

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(deltas.join("")).toBe("第一段第二段");
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    expect(usages).toEqual([{ reason: "stop", input: 15, output: 30 }]);
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "stop",
      usage: expect.objectContaining({ inputTokens: 15, outputTokens: 30 }),
    }));
    const secondCall = mocks.streamText.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    expect(secondCall.messages.at(-1)?.content).toContain("从刚才中断处继续");
  });

  it("finishReason=tool-calls（撞 stopWhen 步数上限）自动续写，不当异常抛错炸链（修多角色接力硬失败 bug）", async () => {
    mocks.streamText
      .mockReturnValueOnce(makeSuccessStream(["先读了一半文件"], { inputTokens: 10, outputTokens: 20 }, "tool-calls"))
      .mockReturnValueOnce(makeSuccessStream(["读完了，结论是……"], { inputTokens: 5, outputTokens: 10 }, "stop"));

    const deltas: string[] = [];
    const result = await streamWithFallback(
      [primary],
      [{ role: "user", content: "帮我读完整个项目" }],
      { onDelta: (d) => deltas.push(d) },
    );

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(deltas.join("")).toBe("先读了一半文件读完了，结论是……");
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    const secondCall = mocks.streamText.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    expect(secondCall.messages.at(-1)?.content).toContain("从刚才中断处继续");
  });

  it("流式输出一半后网络断开时，切 fallback 并带上已输出片段继续", async () => {
    mocks.streamText
      .mockReturnValueOnce(makePartialFailingStream(["已经完成一半。"], new Error("fetch failed")))
      .mockReturnValueOnce(makeSuccessStream(["继续完成剩余。"], { inputTokens: 8, outputTokens: 12 }, "stop"));

    const deltas: string[] = [];
    const switched: Array<{ from: string; to: string }> = [];
    const cbs: StreamCallbacks = {
      onDelta: (d) => deltas.push(d),
      onSwitched: (from, to) => switched.push({ from: from.modelId, to: to.modelId }),
    };

    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "继续做完整任务" }],
      cbs,
    );

    expect(result).toEqual({ usedModelId: "m-fallback", switched: true });
    expect(deltas.join("")).toBe("已经完成一半。继续完成剩余。");
    expect(switched).toEqual([{ from: "m-primary", to: "m-fallback" }]);
    const secondCall = mocks.streamText.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    expect(secondCall.messages.some((m) => m.role === "assistant" && m.content === "已经完成一半。")).toBe(true);
    expect(secondCall.messages.at(-1)?.content).toContain("不要重复已经完成的内容");
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "m-primary",
      finishReason: "network",
    }));
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "m-fallback",
      finishReason: "stop",
    }));
  });

  it("同一模型连续截断超过续写预算后切 fallback，不能把 length 当正常完成", async () => {
    mocks.streamText
      .mockReturnValueOnce(makeSuccessStream(["A"], { inputTokens: 1, outputTokens: 1 }, "length"))
      .mockReturnValueOnce(makeSuccessStream(["B"], { inputTokens: 1, outputTokens: 1 }, "length"))
      .mockReturnValueOnce(makeSuccessStream(["C"], { inputTokens: 1, outputTokens: 1 }, "length"))
      .mockReturnValueOnce(makeSuccessStream(["D"], { inputTokens: 1, outputTokens: 1 }, "stop"));

    const deltas: string[] = [];
    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "写到完整结束" }],
      { onDelta: (d) => deltas.push(d) },
    );

    expect(result).toEqual({ usedModelId: "m-fallback", switched: true });
    expect(deltas.join("")).toBe("ABCD");
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "m-fallback",
      finishReason: "stop",
    }));
  });

  it("finishReason=end_turn 视为正常完成，兼容 Claude/Codex CLI stop_reason", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"], { inputTokens: 2, outputTokens: 3 }, "end_turn"));

    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      { onDelta: () => {} },
    );

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "end_turn",
    }));
  });

  it("finishReason=content_filter 这类非正常结束不能当成功，会切 fallback 继续", async () => {
    mocks.streamText
      .mockReturnValueOnce(makeSuccessStream(["半截"], { inputTokens: 1, outputTokens: 1 }, "content_filter"))
      .mockReturnValueOnce(makeSuccessStream(["恢复"], { inputTokens: 1, outputTokens: 1 }, "stop"));

    const deltas: string[] = [];
    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      { onDelta: (d) => deltas.push(d) },
    );

    expect(result).toEqual({ usedModelId: "m-fallback", switched: true });
    expect(deltas.join("")).toBe("半截恢复");
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "m-primary",
      finishReason: "content_filter",
    }));
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "m-fallback",
      finishReason: "stop",
    }));
  });
});

describe("streamWithFallback - 无 fallback", () => {
  it("主模型失败直接抛错（没有 fallback）", async () => {
    mocks.streamText.mockReturnValueOnce(
      makeFailingStream({ statusCode: 401, message: "bad key" }),
    );
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await expect(
      streamWithFallback([primary], [{ role: "user", content: "x" }], cbs),
    ).rejects.toBeDefined();
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
  });

  it("无 fallback 时 cooldown 跳过会抛错", async () => {
    markModelFailed(primary.modelId);
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await expect(
      streamWithFallback([primary], [{ role: "user", content: "x" }], cbs),
    ).rejects.toThrow(/cooling|unavailable|fallback/i);
  });
});

describe("streamWithFallback - cooldown 行为", () => {
  it("主模型在 cooldown → 直接用 fallback + 触发 onSwitched(kind=cooldown)", async () => {
    markModelFailed(primary.modelId);
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["from fallback"]));

    const switched: Array<{ from: string; to: string; reason: SwitchReason }> = [];
    const cbs: StreamCallbacks = {
      onDelta: () => {},
      onSwitched: (f, t, r) => switched.push({ from: f.modelId, to: t.modelId, reason: r }),
    };

    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
    );
    expect(result.switched).toBe(true);
    expect(result.usedModelId).toBe("m-fallback");
    expect(switched).toHaveLength(1);
    expect(switched[0]!.reason).toEqual({ kind: "cooldown" }); // ⚠️ 不再假报 rate_limit
  });

  it("主模型成功后清空 cooldown", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs);
    expect(isInCooldown(primary.modelId)).toBe(false);
  });

  it("主模型失败 → markModelFailed 把它丢进 cooldown", async () => {
    mocks.streamText.mockReturnValueOnce(
      makeFailingStream({ statusCode: 500, message: "fail" }),
    );
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary, fallback], [{ role: "user", content: "x" }], cbs);
    expect(isInCooldown(primary.modelId)).toBe(true);
  });

  // 真实事故（2026-07-05）：链上所有模型都在冷却中时，之前抛的是一句生硬英文
  // "All models are cooling down — please try again later"，用户不知道具体哪个模型、
  // 还要等多久。现在报错里要带上每个模型的显示名 + 剩余分钟，交给 error-classifier.ts 翻译。
  it("链上所有模型都在冷却中 → 抛错带上每个模型的名字和剩余分钟数", async () => {
    markModelFailed(primary.modelId);
    markModelFailed(fallback.modelId);
    const cbs: StreamCallbacks = { onDelta: () => {} };

    await expect(streamWithFallback([primary, fallback], [{ role: "user", content: "x" }], cbs)).rejects.toThrow(
      /All models are cooling down: Primary（还需 \d+ 分钟）、Fallback（还需 \d+ 分钟）/,
    );
  });
});

describe("streamWithFallback - abort 处理", () => {
  it("主动 abort 不算失败、不切 fallback、不写 UsageEvent", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    mocks.streamText.mockReturnValueOnce(makeFailingStream(abortError));

    const switched: string[] = [];
    const cbs: StreamCallbacks = {
      onDelta: () => {},
      onSwitched: (f, t) => switched.push(`${f.modelId}→${t.modelId}`),
    };

    const controller = new AbortController();
    controller.abort();
    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
      { signal: controller.signal },
    );
    expect(result.switched).toBe(false);
    expect(switched).toEqual([]);
    expect(recordUsageEvent).not.toHaveBeenCalled();
  });
});

describe("streamWithFallback - 内置 recordUsageEvent（修 ChatPage 写错 modelName 的 bug）", () => {
  it("主模型成功时调 recordUsageEvent 用主模型的 modelName/providerId/apiCredentialId", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
      { projectId: "p-1" },
    );
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "m-primary",
        modelName: "primary-model",
        providerId: "prov-anthropic",
        apiCredentialId: "cred-anthropic",
        projectId: "p-1",
        finishReason: "stop",
        interrupted: false,
      }),
    );
  });

  it("切到 fallback 时 recordUsageEvent 改用 fallback 的 modelName/providerId/apiCredentialId（修 latent bug）", async () => {
    mocks.streamText.mockReturnValueOnce(
      makeFailingStream({ statusCode: 401, message: "bad key" }),
    );
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
    );
    expect(recordUsageEvent).toHaveBeenCalledTimes(2);
    expect(recordUsageEvent).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        modelId: "m-primary",
        finishReason: "auth_invalid",
      }),
    );
    expect(recordUsageEvent).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        modelId: "m-fallback", // ✅ 不再误报为 m-primary
        modelName: "fallback-model", // ✅ 不再误报为 primary-model
        providerId: "prov-openai", // ✅ 不再误报为 prov-anthropic
        apiCredentialId: "cred-openai", // ✅ 不再误报为 cred-anthropic
      }),
    );
  });

  it("不传 projectId 时不写 projectId 字段", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs);
    const call = vi.mocked(recordUsageEvent).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("projectId");
  });
});

describe("streamWithFallback - toolChoice（harness nudge 逼真调用工具）", () => {
  it("传了 tools 但不传 toolChoice → 默认 auto", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs, {
      tools: {} as never,
    });
    expect(mocks.streamText.mock.calls[0]![0]).toMatchObject({ toolChoice: "auto" });
  });

  it("nudge 重答时传 toolChoice:'required' → 原样透传给 streamText（不是文字提醒，是 API 层锁死）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs, {
      tools: {} as never,
      toolChoice: "required",
    });
    expect(mocks.streamText.mock.calls[0]![0]).toMatchObject({ toolChoice: "required" });
  });

  it("不传 tools 时不传 toolChoice 给 streamText（没工具的场景不该出现这个字段）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs);
    expect(mocks.streamText.mock.calls[0]![0]).not.toHaveProperty("toolChoice");
  });
});

describe("toModelEndpoint builder", () => {
  it("从 DB 形态构造端点（含 providerType 校验）", () => {
    const ep = toModelEndpoint(
      {
        id: "m-1",
        name: "claude-opus-4-8",
        displayName: "Opus 4.8",
        providerId: "prov-anthropic",
        provider: { type: "anthropic" },
      },
      { id: "cred-1", baseUrl: "https://api.example.com" },
      "sk-test",
    );
    expect(ep).toEqual({
      modelId: "m-1",
      modelName: "claude-opus-4-8",
      providerType: "anthropic",
      providerId: "prov-anthropic",
      apiCredentialId: "cred-1",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com",
      displayLabel: "Opus 4.8",
    });
  });

  it("displayName 为 null 时用 model.name 兜底", () => {
    const ep = toModelEndpoint(
      {
        id: "m-1",
        name: "claude-opus-4-8",
        displayName: null,
        providerId: "p",
        provider: { type: "anthropic" },
      },
      { id: "c", baseUrl: "" },
      "k",
    );
    expect(ep.displayLabel).toBe("claude-opus-4-8");
  });

  it("provider 缺失或 type 为空 → 抛错", () => {
    expect(() =>
      toModelEndpoint(
        { id: "m", name: "x", displayName: null, providerId: "p", provider: null },
        { id: "c", baseUrl: "" },
        "k",
      ),
    ).toThrow(/provider type|re-add/i);
    expect(() =>
      toModelEndpoint(
        { id: "m", name: "x", displayName: null, providerId: "p", provider: { type: "" } },
        { id: "c", baseUrl: "" },
        "k",
      ),
    ).toThrow(/provider type|re-add/i);
  });
});
