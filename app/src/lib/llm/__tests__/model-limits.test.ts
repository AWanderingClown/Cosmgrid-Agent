import { describe, it, expect, afterEach } from "vitest";
import {
  parseModelsDev,
  parseModelsDevContext,
  parseModelsDevToolCall,
  parseModelsDevVision,
  resolveMaxOutputTokens,
  resolveContextBudget,
  resolveSseFirstByteTimeoutMs,
  getModelOutputLimit,
  getModelContextWindow,
  getModelToolCallSupport,
  getModelVisionSupport,
  __setLimitMapForTest,
  MAX_OUTPUT_TOKENS_CEILING,
  DEFAULT_COMPRESSION_BUDGET,
  COMPACTION_RESERVE_CEILING,
  DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  REASONING_FIRST_BYTE_TIMEOUT_MS,
} from "../model-limits";

afterEach(() => __setLimitMapForTest(null));

describe("parseModelsDev", () => {
  it("从 models.dev 结构抽出 modelId → output 上限", () => {
    const json = {
      anthropic: {
        models: {
          "claude-opus-4-8": { limit: { context: 200_000, output: 32_000 } },
        },
      },
      minimax: {
        models: {
          "minimax-m3": { id: "MiniMax-M3", limit: { context: 1_000_000, output: 40_960 } },
        },
      },
    };
    const map = parseModelsDev(json);
    expect(map.get("claude-opus-4-8")).toBe(32_000);
    expect(map.get("minimax-m3")).toBe(40_960);
    // meta.id 也建索引（大小写归一）
    expect(map.get("minimax-m3")).toBe(40_960);
  });

  it("缺 limit.output / 非法输入 → 跳过，不抛错", () => {
    expect(parseModelsDev(null).size).toBe(0);
    expect(parseModelsDev({ p: { models: { m: {} } } }).size).toBe(0);
    expect(parseModelsDev({ p: { models: { m: { limit: { output: 0 } } } } }).size).toBe(0);
  });
});

describe("resolveMaxOutputTokens", () => {
  it("查不到模型 → 用 CEILING 兜底", () => {
    __setLimitMapForTest(new Map());
    expect(resolveMaxOutputTokens("unknown-model")).toBe(MAX_OUTPUT_TOKENS_CEILING);
  });

  it("表未加载（null）→ 也用 CEILING 兜底", () => {
    __setLimitMapForTest(null);
    expect(resolveMaxOutputTokens("anything")).toBe(MAX_OUTPUT_TOKENS_CEILING);
  });

  it("模型输出上限大于 CEILING → 封顶到 CEILING", () => {
    __setLimitMapForTest(new Map([["big-model", 65_536]]));
    expect(resolveMaxOutputTokens("big-model")).toBe(MAX_OUTPUT_TOKENS_CEILING);
  });

  it("模型输出上限小于 CEILING → clamp 到模型真实上限（避免小上限模型被 400 拒）", () => {
    __setLimitMapForTest(new Map([["gemini-2.0-flash", 8_192]]));
    expect(resolveMaxOutputTokens("gemini-2.0-flash")).toBe(8_192);
  });

  it("大小写无关匹配", () => {
    // 用低于 CEILING 的值，验证匹配到的是模型真实上限本身
    __setLimitMapForTest(new Map([["some-small-model", 16_000]]));
    expect(resolveMaxOutputTokens("Some-Small-Model")).toBe(16_000);
    expect(getModelOutputLimit("SOME-SMALL-MODEL")).toBe(16_000);
  });
});

describe("parseModelsDevContext", () => {
  it("从 models.dev 结构抽出 modelId → 上下文窗口（跟 output 是两张独立的表）", () => {
    const json = {
      anthropic: {
        models: {
          "claude-opus-4-8": { limit: { context: 200_000, output: 32_000 } },
        },
      },
      minimax: {
        models: {
          "minimax-m3": { id: "MiniMax-M3", limit: { context: 1_000_000, output: 40_960 } },
        },
      },
    };
    const contextMap = parseModelsDevContext(json);
    expect(contextMap.get("claude-opus-4-8")).toBe(200_000);
    expect(contextMap.get("minimax-m3")).toBe(1_000_000);
  });

  it("缺 limit.context → 跳过，不抛错", () => {
    expect(parseModelsDevContext(null).size).toBe(0);
    expect(parseModelsDevContext({ p: { models: { m: { limit: { output: 1000 } } } } }).size).toBe(0);
  });
});

describe("resolveContextBudget", () => {
  afterEach(() => __setLimitMapForTest(null, null));

  it("模型上下文窗口和输出上限都查不到 → 退回 DEFAULT_COMPRESSION_BUDGET（沿用改造前固定预算）", () => {
    __setLimitMapForTest(new Map(), new Map());
    expect(resolveContextBudget("unknown-model")).toBe(DEFAULT_COMPRESSION_BUDGET);
  });

  it("调用方传了 knownContextWindow（如 DB 里 models.contextWindow）→ 优先用它，不查 models.dev 表", () => {
    __setLimitMapForTest(new Map([["big-model", 8_000]]), new Map([["big-model", 50_000]]));
    // knownContextWindow 传 1,000,000，应该完全盖过上面 models.dev 表里的 50_000
    const budget = resolveContextBudget("big-model", 1_000_000);
    expect(budget).toBe(1_000_000 - Math.min(COMPACTION_RESERVE_CEILING, 8_000));
  });

  it("没传 knownContextWindow → 退回查 models.dev 的上下文窗口表", () => {
    __setLimitMapForTest(new Map([["minimax-m3", 40_960]]), new Map([["minimax-m3", 1_000_000]]));
    const budget = resolveContextBudget("minimax-m3");
    // 预留 = min(20_000, 40_960) = 20_000
    expect(budget).toBe(1_000_000 - COMPACTION_RESERVE_CEILING);
  });

  it("getModelContextWindow 直接查表，大小写无关", () => {
    __setLimitMapForTest(new Map(), new Map([["gemini-2.5-pro", 1_000_000]]));
    expect(getModelContextWindow("Gemini-2.5-Pro")).toBe(1_000_000);
    expect(getModelContextWindow("unknown")).toBeUndefined();
  });

  it("大上下文模型不再被写死的 12000 卡住——预算应该远大于 DEFAULT_COMPRESSION_BUDGET", () => {
    __setLimitMapForTest(new Map([["claude-opus-4-8", 32_000]]), new Map([["claude-opus-4-8", 200_000]]));
    const budget = resolveContextBudget("claude-opus-4-8");
    expect(budget).toBeGreaterThan(DEFAULT_COMPRESSION_BUDGET);
    expect(budget).toBe(200_000 - COMPACTION_RESERVE_CEILING);
  });

  it("模型真实输出上限比 COMPACTION_RESERVE_CEILING 还小 → 按真实输出上限预留，不多扣", () => {
    __setLimitMapForTest(new Map([["small-output-model", 4_000]]), new Map([["small-output-model", 32_000]]));
    const budget = resolveContextBudget("small-output-model");
    expect(budget).toBe(32_000 - 4_000);
  });

  it("上下文窗口小到扣完预留就 <= 0 → 退回 DEFAULT_COMPRESSION_BUDGET，不返回负数/零", () => {
    __setLimitMapForTest(new Map([["tiny-model", 8_000]]), new Map([["tiny-model", 4_000]]));
    expect(resolveContextBudget("tiny-model")).toBe(DEFAULT_COMPRESSION_BUDGET);
  });
});

describe("parseModelsDevToolCall / parseModelsDevVision", () => {
  const json = {
    anthropic: {
      models: {
        "claude-opus-4-8": { tool_call: true, modalities: { input: ["text", "image"] } },
      },
    },
    minimax: {
      models: {
        "minimax-m3": { id: "MiniMax-M3", tool_call: false, modalities: { input: ["text"] } },
      },
    },
  };

  it("抽出 tool_call 布尔位（双索引：完整 id + meta.id）", () => {
    const map = parseModelsDevToolCall(json);
    expect(map.get("claude-opus-4-8")).toBe(true);
    expect(map.get("minimax-m3")).toBe(false);
  });

  it("抽出 modalities.input 是否含 image", () => {
    const map = parseModelsDevVision(json);
    expect(map.get("claude-opus-4-8")).toBe(true);
    expect(map.get("minimax-m3")).toBe(false);
  });

  it("缺字段/非法输入 → 跳过，不抛错", () => {
    expect(parseModelsDevToolCall(null).size).toBe(0);
    expect(parseModelsDevToolCall({ p: { models: { m: {} } } }).size).toBe(0);
    expect(parseModelsDevVision({ p: { models: { m: { modalities: { input: "not-an-array" } } } } }).size).toBe(0);
  });

  it("getModelToolCallSupport/getModelVisionSupport：查不到时返回 undefined（不确定，不是 false）", () => {
    __setLimitMapForTest(null, null, new Map([["known-model", true]]), new Map([["known-model", false]]));
    expect(getModelToolCallSupport("known-model")).toBe(true);
    expect(getModelVisionSupport("known-model")).toBe(false);
    expect(getModelToolCallSupport("unknown-model")).toBeUndefined();
    expect(getModelVisionSupport("unknown-model")).toBeUndefined();
  });
});

describe("resolveSseFirstByteTimeoutMs", () => {
  it("普通模型走默认 60s", () => {
    expect(resolveSseFirstByteTimeoutMs("claude-sonnet-4-6")).toBe(DEFAULT_FIRST_BYTE_TIMEOUT_MS);
  });

  it("重 reasoning 模型放宽到 180s", () => {
    expect(resolveSseFirstByteTimeoutMs("gpt-5")).toBe(REASONING_FIRST_BYTE_TIMEOUT_MS);
    expect(resolveSseFirstByteTimeoutMs("MiniMax-M3")).toBe(REASONING_FIRST_BYTE_TIMEOUT_MS);
    expect(resolveSseFirstByteTimeoutMs("o3")).toBe(REASONING_FIRST_BYTE_TIMEOUT_MS);
  });
});
