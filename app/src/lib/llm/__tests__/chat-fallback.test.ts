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

describe("streamWithFallback - 主模型正常", () => {
  it("主模型成功时不切 fallback", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["Hi", " there"]));

    const deltas: string[] = [];
    const switched: Array<unknown> = [];
    const usages: Array<{ mid: string; reason: string }> = [];
    const cbs: StreamCallbacks = {
      onDelta: (d) => deltas.push(d),
      onSwitched: (f, t, r) => switched.push({ from: f.modelId, to: t.modelId, r }),
      onUsage: (_u, m, r) => usages.push({ mid: m.modelId, reason: r }),
    };

    const result = await streamWithFallback([primary, fallback], [{ role: "user", content: "hi" }], cbs);
    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(deltas.join("")).toBe("Hi there");
    expect(switched).toEqual([]);
    expect(usages).toEqual([{ mid: "m-primary", reason: "stop" }]);
  });

  it("主模型成功时调用一次 streamText（不调 fallback）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary, fallback], [{ role: "user", content: "x" }], cbs);
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
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
    const cbs: StreamCallbacks = {
      onDelta: (d) => deltas.push(d),
      onSwitched: (f, t, r) => switched.push({ from: f.modelId, to: t.modelId, reason: r }),
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
    } else {
      await expect(
        streamWithFallback([primary, fallback], [{ role: "user", content: "x" }], cbs),
      ).rejects.toBeDefined();
      expect(switched).toEqual([]);
      expect(mocks.streamText).toHaveBeenCalledTimes(1);
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
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent).toHaveBeenCalledWith(
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
