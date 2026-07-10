// debate-runner 单测（6.3 修复：补覆盖）
// 之前只靠 debate-engine 的 mock 测试兜底，真实 I/O 边界代码（CLI 分流 / maxOutputTokens /
// 错误包装 / AbortError 透传）从未被覆盖。这是产品重点场景（多模型对弈），补测试。

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
  streamViaCli: vi.fn(),
  recordUsageEvent: vi.fn(),
  resolveMaxOutputTokens: vi.fn(() => 4096),
  getLanguageModel: vi.fn(() => ({ __mock: true, provider: "test" })),
  isCliProviderType: vi.fn((t: string) => t === "claude-cli" || t === "codex-cli"),
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  generateObject: mocks.generateObject,
}));
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

const { realRunRole, runJudgeDecisionStructured } = await import("../debate-runner");

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

  it("res.usage 缺失 → inputTokens/outputTokens 默认 0（line 54-55 ?? 0 分支）", async () => {
    mocks.generateText.mockResolvedValue({
      text: "ok",
      // 用法：v8 算 branch 时 ?? 0 这个默认值必须被实际跑到
      usage: undefined,
    });

    const result = await realRunRole({
      systemPrompt: "sys",
      userPrompt: "user",
      config: baseConfig,
    });

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
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

describe("realRunRole - CLI 配置透传", () => {
  it("CLI provider 传 baseUrl → streamViaCli 收到 program 字段 + onDelta 累加 content", async () => {
    // 让 mock 真的调一下 onDelta，验证 content 累加分支（line 38）
    mocks.streamViaCli.mockImplementation(async (_cfg, _messages, opts) => {
      opts.onDelta("hello ");
      opts.onDelta("world");
      return {
        inputTokens: 10,
        outputTokens: 5,
        finishReason: "stop",
        officialSessionId: null,
        actualModelName: null,
      };
    });

    const result = await realRunRole({
      systemPrompt: "sys",
      userPrompt: "user",
      config: {
        ...baseConfig,
        providerType: "claude-cli",
        baseUrl: "/usr/local/bin/claude",
      },
    });

    expect(result.content).toBe("hello world");
    const callArgs = mocks.streamViaCli.mock.calls[0]![0] as {
      providerType: string;
      modelName: string;
      program?: string;
    };
    expect(callArgs.program).toBe("/usr/local/bin/claude");
    // 没传 workingDirectory 时不要塞空字段
    expect(callArgs).not.toHaveProperty("workingDirectory");
  });

  it("CLI provider 传 workingDirectory → streamViaCli 收到 workingDirectory 字段", async () => {
    mocks.streamViaCli.mockResolvedValue({
      inputTokens: 10,
      outputTokens: 5,
      finishReason: "stop",
      officialSessionId: null,
      actualModelName: null,
    });

    await realRunRole({
      systemPrompt: "sys",
      userPrompt: "user",
      config: {
        ...baseConfig,
        providerType: "codex-cli",
        baseUrl: undefined,
        workingDirectory: "/tmp/work",
      },
    });

    const callArgs = mocks.streamViaCli.mock.calls[0]![0] as {
      workingDirectory?: string;
    };
    expect(callArgs.workingDirectory).toBe("/tmp/work");
  });
});

// ====== runJudgeDecisionStructured（整函数之前 0 测试，补齐） ======

const baseJudgeConfig = {
  role: "judge" as const,
  modelId: "judge-m-1",
  modelName: "judge-model",
  providerType: "openai",
  providerId: "p-1",
  apiCredentialId: "c-1",
  apiKey: "sk-judge",
  baseUrl: "https://api.test.com",
  workingDirectory: null,
};

const baseJudgeArgs = {
  topic: "给个方案",
  proposalContent: "原方案正文",
  critiques: [
    {
      role: "critic" as const,
      modelId: "critic-m",
      content: "这个方案有 bug",
      inputTokens: 10,
      outputTokens: 5,
    },
  ],
};

describe("runJudgeDecisionStructured - CLI provider 短路", () => {
  it("judge providerType 是 CLI → 直接返 null（走旧 parseJudgeDecision 路径）", async () => {
    const result = await runJudgeDecisionStructured({
      ...baseJudgeArgs,
      judgeConfig: { ...baseJudgeConfig, providerType: "claude-cli" },
    });

    expect(result).toBeNull();
    // CLI 分支根本不该调到 generateObject
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });
});

describe("runJudgeDecisionStructured - API 成功路径", () => {
  it("返回 generateObject 的结构化结果 + 落 UsageEvent role=debate_judge_structured", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        approved: true,
        feedback: ["微调一下"],
        finalSolution: "修正后的最终方案",
      },
      usage: { inputTokens: 200, outputTokens: 100 },
    });

    const result = await runJudgeDecisionStructured({
      ...baseJudgeArgs,
      judgeConfig: baseJudgeConfig,
    });

    expect(result).toEqual({
      approved: true,
      feedback: ["微调一下"],
      finalSolution: "修正后的最终方案",
    });
    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "debate_judge_structured",
        modelId: "judge-m-1",
        finishReason: "stop",
        usage: { inputTokens: 200, outputTokens: 100 },
      }),
    );
    // judgeConfig 的 maxOutputTokens 应来自 resolveMaxOutputTokens(modelName)
    expect(mocks.resolveMaxOutputTokens).toHaveBeenCalledWith("judge-model");
    expect(mocks.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 4096 }),
    );
  });

  it("approved=false / 合法 feedback 数组 / 合法 finalSolution 都正常映射", async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        approved: false,
        feedback: ["把 X 改了解决 Y", "补全 Z 维度"],
        finalSolution: "重做方案",
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await runJudgeDecisionStructured({
      ...baseJudgeArgs,
      judgeConfig: baseJudgeConfig,
    });

    expect(result?.approved).toBe(false);
    expect(result?.feedback).toEqual(["把 X 改了解决 Y", "补全 Z 维度"]);
    expect(result?.finalSolution).toBe("重做方案");
  });

  it("critiques 为空时仍能生成 user prompt（不依赖批评分支）", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { approved: true, feedback: [], finalSolution: "原方案即可" },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await runJudgeDecisionStructured({
      ...baseJudgeArgs,
      critiques: [],
      judgeConfig: baseJudgeConfig,
    });

    expect(result?.approved).toBe(true);
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
  });

  it("res.usage 缺失 → inputTokens/outputTokens 默认 0", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { approved: true, feedback: [], finalSolution: "ok" },
      // 用法：v8 算 branch 时 ?? 0 这个默认值必须被实际跑到
      usage: undefined,
    });

    await runJudgeDecisionStructured({
      ...baseJudgeArgs,
      judgeConfig: baseJudgeConfig,
    });

    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
  });
});

describe("runJudgeDecisionStructured - 字段归一化（边界类型）", () => {
  it("object.approved 不是 boolean → 强制转 false", async () => {
    // zod schema 严格下不该出现，但运行期 zod 不抛错时仍要兜底
    mocks.generateObject.mockResolvedValue({
      object: { approved: "yes", feedback: [], finalSolution: "ok" },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await runJudgeDecisionStructured({
      ...baseJudgeArgs,
      judgeConfig: baseJudgeConfig,
    });

    expect(result?.approved).toBe(false);
  });

  it("object.feedback 不是数组 → 强制空数组", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { approved: true, feedback: "not an array", finalSolution: "ok" },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await runJudgeDecisionStructured({
      ...baseJudgeArgs,
      judgeConfig: baseJudgeConfig,
    });

    expect(result?.feedback).toEqual([]);
  });

  it("object.finalSolution 不是字符串 → 强制空串", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { approved: true, feedback: [], finalSolution: 12345 },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await runJudgeDecisionStructured({
      ...baseJudgeArgs,
      judgeConfig: baseJudgeConfig,
    });

    expect(result?.finalSolution).toBe("");
  });
});

describe("runJudgeDecisionStructured - 错误分支", () => {
  it("AbortError（name === 'AbortError'）原样抛 → 调用方按已停止处理", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    mocks.generateObject.mockRejectedValue(abortError);

    await expect(
      runJudgeDecisionStructured({
        ...baseJudgeArgs,
        judgeConfig: baseJudgeConfig,
      }),
    ).rejects.toBe(abortError);
  });

  it("signal.aborted=true 时也走原样抛路径（即使 err.name 不是 AbortError）", async () => {
    const controller = new AbortController();
    controller.abort();
    const other = new Error("connection reset");
    mocks.generateObject.mockRejectedValue(other);

    await expect(
      runJudgeDecisionStructured({
        ...baseJudgeArgs,
        judgeConfig: baseJudgeConfig,
        signal: controller.signal,
      }),
    ).rejects.toBe(other);
  });

  it("普通错误 → 返 null（让 debate-engine 兜底到 parseJudgeDecision，不阻断主对话）", async () => {
    mocks.generateObject.mockRejectedValue(new Error("rate limit exceeded"));

    const result = await runJudgeDecisionStructured({
      ...baseJudgeArgs,
      judgeConfig: baseJudgeConfig,
    });

    expect(result).toBeNull();
  });

  it("非 Error 抛错也走返 null 路径（不抛上去）", async () => {
    mocks.generateObject.mockRejectedValue("plain string error");

    const result = await runJudgeDecisionStructured({
      ...baseJudgeArgs,
      judgeConfig: baseJudgeConfig,
    });

    expect(result).toBeNull();
  });
});
