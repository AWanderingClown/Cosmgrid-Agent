import { describe, expect, it } from "vitest";
import {
  calculateCacheSavings,
  calculateCompressionSavings,
  calculateRoutingSavings,
} from "../savings-calculator";

describe("calculateCacheSavings", () => {
  it("按 cache hit token 和显式 cache read 价格计算省钱", () => {
    const result = calculateCacheSavings({
      usage: { cacheReadInputTokens: 500_000 },
      actualCost: 1,
      resolvedPrice: {
        catalogId: "price-1",
        input: 3,
        output: 15,
        cacheRead: 0.3,
        contextWindow: 200000,
        version: "test",
        source: "remote",
        sourceUrl: null,
      },
    });

    expect(result).toMatchObject({
      baselineCost: 2.35,
      actualCost: 1,
      savedCost: 1.35,
    });
  });

  it("没有显式 cache read 价格时不乱猜", () => {
    expect(calculateCacheSavings({
      usage: { cacheReadInputTokens: 500_000 },
      actualCost: 1,
      resolvedPrice: {
        catalogId: "price-1",
        input: 3,
        output: 15,
        contextWindow: 200000,
        version: "test",
        source: "remote",
        sourceUrl: null,
      },
    })).toBeNull();
  });
});

describe("calculateRoutingSavings", () => {
  it("只在基线模型更贵时记录省钱", () => {
    expect(calculateRoutingSavings({
      baselineCost: 0.12,
      actualCost: 0.03,
      baselineModelId: "gpt-5",
      actualModelId: "gpt-5-mini",
    })).toMatchObject({
      baselineCost: 0.12,
      actualCost: 0.03,
      savedCost: 0.09,
    });
  });
});

describe("calculateCompressionSavings", () => {
  it("按压缩前后 token 差额计算输入侧省钱", () => {
    expect(calculateCompressionSavings({
      beforeTokens: 12000,
      afterTokens: 4000,
      inputPricePer1m: 5,
    })).toMatchObject({
      baselineCost: 0.06,
      actualCost: 0.02,
      savedCost: 0.04,
    });
  });
});
