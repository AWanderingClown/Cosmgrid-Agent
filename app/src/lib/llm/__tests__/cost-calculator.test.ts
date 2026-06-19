import { describe, it, expect, vi, afterEach } from "vitest";
import { calculateCost } from "../cost-calculator";

describe("calculateCost", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未知模型返回 0", () => {
    expect(calculateCost("unknown-model-xyz", { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });

  it("claude-sonnet-4-6: 1M input + 1M output = $18", () => {
    // input=$3/1M, output=$15/1M
    const cost = calculateCost("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(18);
  });

  it("usage 全为 0 时成本为 0", () => {
    expect(calculateCost("claude-sonnet-4-6", { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("cache read 命中时成本低于纯 input", () => {
    const withCache = calculateCost("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    });
    const withoutCache = calculateCost("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(withCache).toBeLessThan(withoutCache);
  });

  it("返回值精度不超过 4 位小数", () => {
    const cost = calculateCost("claude-sonnet-4-6", {
      inputTokens: 100,
      outputTokens: 100,
    });
    const str = cost.toString();
    const decimals = str.includes(".") ? str.split(".")[1]!.length : 0;
    expect(decimals).toBeLessThanOrEqual(4);
  });

  it("大小写不敏感：Claude-Sonnet-4-6 也能找到", () => {
    const cost = calculateCost("Claude-Sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBeGreaterThan(0);
  });
});
