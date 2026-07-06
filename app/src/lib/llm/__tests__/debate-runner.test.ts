// debate-runner 单测（6.3 修复：补覆盖）
// 之前只靠 debate-engine 的 mock 测试兜底，真实 I/O 边界代码（CLI 分流 / maxOutputTokens /
// 错误包装 / AbortError 透传）从未被覆盖。这是产品重点场景（多模型对弈），补测试。

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamViaCli: vi.fn(),
  recordUsageEvent: vi.fn(),
  resolveMaxOutputTokens: vi.fn(() => 4096),
  getLanguageModel: vi.fn(() => ({ __mock: true, provider: "test" })),
  isCliProviderType: vi.fn((t: string) => t === "claude-cli" || t === "codex-cli"),
}));

vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("../provider-factory", () => ({
  getLanguageModel: mocks.getLanguageModel,
}));
vi.mock("../model-limits", () => ({
  resolveMaxOutputTokens: mocks.resolveMaxOutputTokens,
}));
vi.mock("../usage-tracker", () => ({
  recordUsageEvent: mocks.recordUsageEvent,
}));
vi.mock("../cli-protocol", () => ({
  isCliProviderType: mocks.isCliProviderType,
}));
vi.mock("../cli-engine", () => ({
  streamViaCli: mocks.streamViaCli,
}));

const { realRunRole } = await import("../debate-runner");

const baseConfig = {
  role: "solver" as const,
  modelId: "m-1",
  modelName: "test-model",
  providerType: "openai",
  providerId: "p-1",
  apiCredentialId: "c-1",
  apiKey: "sk-test",
  baseUrl: "https://api.test.com",
  workingDirectory: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveMaxOutputTokens.mockReturnValue(4096);
  mocks.isCliProviderType.mockImplementation(
    (t: string) => t === "claude-cli" || t === "codex-cli",
  );
  mocks.getLanguageModel.mockReturnValue({ __mock: true, provider: "test" });
});

describe("realRunRole - API 直连路径", () => {
  it("调 generateText + 返回 content + 落 UsageEvent（role=debate_solver）", async () => {
    mocks.generateText.mockResolvedValue({
      text: "这是 solver 的回答",
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const result = await realRunRole({
      systemPrompt: "你是 solver",
      userPrompt: "回答问题",
      config: baseConfig,
    });

    expect(result.content).toBe("这是 solver 的回答");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    // 关键断言：generateText 收到了 resolveMaxOutputTokens 的返回值
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 4096 }),
    );
    // 关键断言：UsageEvent 的 role 字段带 debate_ 前缀（StatsPage 可见对弈成本）
    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "debate_solver",
        modelId: "m-1",
        finishReason: "stop",
      }),
    );
  });

  it("AbortError 原样透传（不污染成模型错误）", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    mocks.generateText.mockRejectedValue(abortError);

    await expect(
      realRunRole({
        systemPrompt: "sys",
        userPrompt: "user",
        config: baseConfig,
      }),
    ).rejects.toBe(abortError);
    // AbortError 不写 UsageEvent（不算模型调用）
    expect(mocks.recordUsageEvent).not.toHaveBeenCalled();
  });

  it("signal.aborted 也走原样透传路径（不包装）", async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.generateText.mockRejectedValue(new Error("other failure"));

    // 注意：signal.aborted=true 时，代码直接 throw err，不包装成「调用失败」格式
    await expect(
      realRunRole({
        systemPrompt: "sys",
        userPrompt: "user",
        config: baseConfig,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/other failure/);
  });

  it("非 AbortError 包装成带「模型+角色+原因」的 Error", async () => {
    mocks.generateText.mockRejectedValue(new Error("rate limit exceeded"));

    await expect(
      realRunRole({
        systemPrompt: "sys",
        userPrompt: "user",
        config: { ...baseConfig, modelName: "MiniMax-Abab5.5s-chat", role: "critic" },
      }),
    ).rejects.toThrow(/MiniMax-Abab5.5s-chat.*critic.*rate limit exceeded/);
  });

  it("非 Error 抛错也包装成字符串", async () => {
    mocks.generateText.mockRejectedValue("plain string error");

    await expect(
      realRunRole({
        systemPrompt: "sys",
        userPrompt: "user",
        config: baseConfig,
      }),
    ).rejects.toThrow(/调用失败：plain string error/);
  });

  it("UsageEvent role 字段加 debate_ 前缀（让 StatsPage 区分对弈 vs 主对话）", async () => {
    mocks.generateText.mockResolvedValue({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await realRunRole({
      systemPrompt: "sys",
      userPrompt: "user",
      config: { ...baseConfig, role: "judge" },
    });

    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ role: "debate_judge" }),
    );
  });
});

describe("realRunRole - CLI 路径", () => {
  it("CLI provider 走 streamViaCli + 返回 content + 落 UsageEvent", async () => {
    mocks.streamViaCli.mockResolvedValue({
      inputTokens: 80,
      outputTokens: 40,
      finishReason: "stop",
      officialSessionId: null,
      actualModelName: null,
    });

    const result = await realRunRole({
      systemPrompt: "你是 critic",
      userPrompt: "评审一下",
      config: { ...baseConfig, providerType: "claude-cli" },
    });

    expect(result.inputTokens).toBe(80);
    expect(result.outputTokens).toBe(40);
    expect(mocks.streamViaCli).toHaveBeenCalledTimes(1);
    expect(mocks.generateText).toHaveBeenCalledTimes(0);
    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "debate_solver",
        providerType: "claude-cli",
      }),
    );
  });

  it("CLI 失败也包装成带模型+角色+原因的 Error", async () => {
    mocks.streamViaCli.mockRejectedValue(new Error("CLI exited with code 1"));

    await expect(
      realRunRole({
        systemPrompt: "sys",
        userPrompt: "user",
        config: { ...baseConfig, providerType: "codex-cli", modelName: "codex-model" },
      }),
    ).rejects.toThrow(/codex-model.*solver.*CLI exited with code 1/);
  });
});

describe("realRunRole - maxOutputTokens 透传", () => {
  it("调用 resolveMaxOutputTokens 拿到模型真实输出上限传给 generateText", async () => {
    mocks.resolveMaxOutputTokens.mockReturnValue(8192);
    mocks.generateText.mockResolvedValue({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await realRunRole({
      systemPrompt: "sys",
      userPrompt: "user",
      config: { ...baseConfig, modelName: "claude-opus-4-8" },
    });

    expect(mocks.resolveMaxOutputTokens).toHaveBeenCalledWith("claude-opus-4-8");
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 8192 }),
    );
  });
});