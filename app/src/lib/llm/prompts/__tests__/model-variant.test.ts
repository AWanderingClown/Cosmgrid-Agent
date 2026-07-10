import { describe, expect, it } from "vitest";
import { resolveModelVariant } from "../model-variant";

describe("resolveModelVariant", () => {
  it("命中国产模型关键词 → domestic", () => {
    expect(resolveModelVariant("MiniMax-M3")).toBe("domestic");
    expect(resolveModelVariant("Kimi-K2")).toBe("domestic");
    expect(resolveModelVariant("GLM-4.6")).toBe("domestic");
    expect(resolveModelVariant("Qwen3-Max")).toBe("domestic");
    expect(resolveModelVariant("DeepSeek-V3")).toBe("domestic");
  });

  it("大小写无关匹配", () => {
    expect(resolveModelVariant("minimax-m3")).toBe("domestic");
  });

  it("不匹配任何国产模型关键词 → default", () => {
    expect(resolveModelVariant("Claude-Opus-4-8")).toBe("default");
    expect(resolveModelVariant("gpt-5")).toBe("default");
  });

  it("null/undefined/空字符串 → default", () => {
    expect(resolveModelVariant(null)).toBe("default");
    expect(resolveModelVariant(undefined)).toBe("default");
    expect(resolveModelVariant("")).toBe("default");
  });
});
