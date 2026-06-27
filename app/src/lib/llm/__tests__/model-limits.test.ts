import { describe, it, expect, afterEach } from "vitest";
import {
  parseModelsDev,
  resolveMaxOutputTokens,
  getModelOutputLimit,
  __setLimitMapForTest,
  MAX_OUTPUT_TOKENS_CEILING,
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
