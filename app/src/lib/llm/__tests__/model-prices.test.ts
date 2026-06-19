import { describe, it, expect } from "vitest";
import { lookupPrice, MODEL_PRICES } from "../model-prices";

describe("lookupPrice", () => {
  it("精确匹配已知模型", () => {
    const price = lookupPrice("claude-sonnet-4-6");
    expect(price).not.toBeNull();
    expect(price!.input).toBe(3);
    expect(price!.output).toBe(15);
  });

  it("大小写不敏感 fallback", () => {
    const price = lookupPrice("Claude-Sonnet-4-6");
    expect(price).not.toBeNull();
    expect(price!.input).toBe(3);
  });

  it("未知模型返回 null", () => {
    expect(lookupPrice("gpt-999-ultra")).toBeNull();
    expect(lookupPrice("")).toBeNull();
  });

  it("所有已知模型都有 input/output/contextWindow", () => {
    for (const [name, price] of Object.entries(MODEL_PRICES)) {
      expect(price.input, `${name}.input`).toBeGreaterThan(0);
      expect(price.output, `${name}.output`).toBeGreaterThan(0);
      expect(price.contextWindow, `${name}.contextWindow`).toBeGreaterThan(0);
    }
  });
});
