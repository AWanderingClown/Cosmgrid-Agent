import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// 隔离：catalog 测试要替换 lookupPriceFromCatalog 的实现，
// catalog 路径本身也会因为 cost-calculator.ts 的 import 副作用被加载，
// 所以提前在 hoisted 阶段就把假 mock 准备好。
const catalogMocks = vi.hoisted(() => ({
  lookupPriceFromCatalog: vi.fn(),
}));

vi.mock("../price-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../price-catalog.js")>("../price-catalog.js");
  return {
    ...actual,
    lookupPriceFromCatalog: catalogMocks.lookupPriceFromCatalog,
  };
});

import {
  calculateCost,
  estimateCost,
  estimateCostWithCatalog,
  type ChatUsage,
} from "../cost-calculator";

describe("calculateCost", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未知模型返回 0", () => {
    expect(calculateCost("unknown-model-xyz", { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });

  it("未知模型显式返回 pricingKnown=false，避免统计页误判为免费", () => {
    expect(estimateCost("unknown-model-xyz", { inputTokens: 1000, outputTokens: 1000 })).toEqual({
      cost: 0,
      pricingKnown: false,
    });
  });

  it("已知模型显式返回 pricingKnown=true", () => {
    const estimate = estimateCost("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(estimate.pricingKnown).toBe(true);
    expect(estimate.cost).toBe(18);
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

describe("estimateCost 额外分支", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // gpt-5 在 model-prices.ts 里只设置 input/output，没有 cacheRead/cacheWrite 字段
  // cacheReadRate 应该回退到 price.input（同价），cacheWriteRate 回退到 input*1.25
  it("无 cacheRead 字段时，cacheRead 走 input 回退价", () => {
    // gpt-5: input=$5/1M, output=$20/1M（无 cacheRead/cacheWrite）
    // 喂 0 new input（让 cacheRate 的差异看得清）+ 1M cache read + 0 output
    // 期望：$5/1M * 1M = $5（不是默认 input price 的特殊折扣价）
    const cost = calculateCost("gpt-5", {
      inputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      outputTokens: 0,
    });
    // nonCacheInput = max(0, 1M - 1M - 0) = 0
    // cacheRead 走 fallback = price.input = 5
    // cost = 0 + 0 + (1M/1M)*5 + 0 = 5
    expect(cost).toBe(5);
  });

  it("无 cacheWrite 字段时，cacheWrite 走 input*1.25 回退价", () => {
    // gpt-5: input=$5/1M，cacheWrite 回退 = 5*1.25 = 6.25
    const cost = calculateCost("gpt-5", {
      inputTokens: 1_000_000,
      cacheWriteInputTokens: 1_000_000,
      outputTokens: 0,
    });
    // nonCacheInput = max(0, 1M - 0 - 1M) = 0
    // cost = 0 + 0 + 0 + (1M/1M)*6.25 = 6.25
    expect(cost).toBe(6.25);
  });

  it("cache 总量超过 input 时，nonCacheInput 被钳到 0，不出现负数成本", () => {
    // provider 偶尔会上报 cache_read + cache_write 合计超过 input（边界）
    // 必须兜底，不然会出现负数成本或被 input 单价重复收费
    const result = estimateCost("claude-sonnet-4-6", {
      inputTokens: 100,
      outputTokens: 0,
      cacheReadInputTokens: 200,
      cacheWriteInputTokens: 0,
    });
    // nonCacheInput = max(0, 100 - 200 - 0) = 0
    // cost = 0 + 0 + (200/1M)*0.3 + 0 = 0.00006 → round 4dp = 0.0001
    expect(result.cost).toBe(0.0001);
    expect(result.cost).toBeGreaterThanOrEqual(0);
  });

  it("reasoningTokens 字段不影响成本（reasoning 已计入 outputTokens）", () => {
    const withoutReasoning = calculateCost("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const withReasoning = calculateCost("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 800_000, // reasoning tokens 应该已经在 outputTokens 里
    });
    expect(withReasoning).toBe(withoutReasoning);
  });
});

describe("estimateCostWithCatalog", () => {
  beforeEach(() => {
    catalogMocks.lookupPriceFromCatalog.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未知模型：返回全 null 元数据 + pricingKnown=false + 打印 warn", async () => {
    catalogMocks.lookupPriceFromCatalog.mockResolvedValueOnce(null);

    const result = await estimateCostWithCatalog("totally-unknown-xyz", {
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(result).toEqual({
      cost: 0,
      pricingKnown: false,
      priceCatalogId: null,
      priceVersion: null,
      priceSource: null,
      priceSourceUrl: null,
      resolvedPrice: null,
    });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("totally-unknown-xyz"),
    );
  });

  it("命中手动目录：返回完整 CatalogCostEstimate 元数据", async () => {
    catalogMocks.lookupPriceFromCatalog.mockResolvedValueOnce({
      catalogId: "manual-row-42",
      input: 1.5,
      output: 6,
      cacheRead: undefined,
      cacheWrite: undefined,
      contextWindow: 128000,
      version: "manual:2026-07-01T00:00:00.000Z",
      source: "manual",
      sourceUrl: null,
    });

    const result = await estimateCostWithCatalog("custom-model", {
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
    });

    expect(result.pricingKnown).toBe(true);
    expect(result.priceCatalogId).toBe("manual-row-42");
    expect(result.priceVersion).toMatch(/^manual:/);
    expect(result.priceSource).toBe("manual");
    expect(result.priceSourceUrl).toBeNull();
    // 2M * 1.5 / 1M = 3; 1M * 6 / 1M = 6 → 3 + 6 = 9
    expect(result.cost).toBe(9);
    expect(result.resolvedPrice).toMatchObject({
      catalogId: "manual-row-42",
      source: "manual",
      input: 1.5,
      output: 6,
    });
  });

  it("命中内置目录：source=builtin，回退价行为同 estimateCost", async () => {
    catalogMocks.lookupPriceFromCatalog.mockResolvedValueOnce({
      catalogId: null,
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      contextWindow: 200_000,
      version: "builtin-2026-06-28",
      source: "builtin",
      sourceUrl: "builtin:claude-haiku-4-5",
    });

    const usage: ChatUsage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadInputTokens: 200_000,
    };

    const result = await estimateCostWithCatalog("claude-haiku-4-5", usage);

    expect(result.pricingKnown).toBe(true);
    expect(result.priceSource).toBe("builtin");
    expect(result.priceVersion).toBe("builtin-2026-06-28");
    expect(result.priceSourceUrl).toBe("builtin:claude-haiku-4-5");
    // nonCache = 1M - 0.2M - 0 = 0.8M → 0.8 * 3 = 2.4
    // output = 0.5M * 15 = 7.5
    // cacheRead = 0.2M * 0.3 = 0.06
    // cacheWrite = 0
    // sum = 2.4 + 7.5 + 0.06 = 9.96
    expect(result.cost).toBe(9.96);
  });

  it("命中无 cacheRead 字段的远程目录：cacheReadRate 回退到 input", async () => {
    catalogMocks.lookupPriceFromCatalog.mockResolvedValueOnce({
      catalogId: "remote-row-99",
      input: 5,
      output: 20,
      // 没有 cacheRead，cost-calculator 应该回退到 input
      cacheRead: undefined,
      // 有 cacheWrite
      cacheWrite: 6.25,
      contextWindow: 256_000,
      version: "models.dev:2026-07-01",
      source: "remote",
      sourceUrl: "https://models.dev/api.json#openai/gpt-5",
    });

    const result = await estimateCostWithCatalog("gpt-5", {
      inputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      outputTokens: 0,
    });

    expect(result.pricingKnown).toBe(true);
    expect(result.priceSource).toBe("remote");
    // cacheRead 回退 = 5，cacheWrite = 6.25
    // nonCacheInput = 0
    // cost = 0 + 0 + 5 + 0 = 5
    expect(result.cost).toBe(5);
  });

  it("providerType 参数透传给 lookupPriceFromCatalog", async () => {
    catalogMocks.lookupPriceFromCatalog.mockResolvedValueOnce({
      catalogId: "x",
      input: 1,
      output: 2,
      cacheRead: undefined,
      cacheWrite: undefined,
      contextWindow: 0,
      version: "manual:test",
      source: "manual",
      sourceUrl: null,
    });

    await estimateCostWithCatalog("some-model", { inputTokens: 0 }, "openai-compatible");
    expect(catalogMocks.lookupPriceFromCatalog).toHaveBeenCalledWith(
      "some-model",
      "openai-compatible",
    );
  });

  it("providerType 缺省时传 undefined（让 lookupPriceFromCatalog 自己处理 ?? null）", async () => {
    catalogMocks.lookupPriceFromCatalog.mockResolvedValueOnce({
      catalogId: "x",
      input: 1,
      output: 2,
      cacheRead: undefined,
      cacheWrite: undefined,
      contextWindow: 0,
      version: "manual:test",
      source: "manual",
      sourceUrl: null,
    });

    await estimateCostWithCatalog("some-model", { inputTokens: 0 });
    expect(catalogMocks.lookupPriceFromCatalog).toHaveBeenCalledWith(
      "some-model",
      undefined,
    );
  });

  it("result.resolvedPrice 直接是 mock 返回的引用（断言同一对象）", async () => {
    const fakeResolved = {
      catalogId: "abc",
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0.2,
      contextWindow: 999,
      version: "manual:abc",
      source: "manual" as const,
      sourceUrl: null,
    };
    catalogMocks.lookupPriceFromCatalog.mockResolvedValueOnce(fakeResolved);

    const result = await estimateCostWithCatalog("m", { inputTokens: 0 });
    expect(result.resolvedPrice).toBe(fakeResolved);
  });
});
