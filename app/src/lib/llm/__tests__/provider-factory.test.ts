import { describe, it, expect } from "vitest";
import { isProviderRegistered, listRegisteredProviders, getLanguageModel } from "../provider-factory";

describe("provider-factory registry", () => {
  it("原生 3 家 + openai-compatible 全部注册", () => {
    const types = listRegisteredProviders();
    expect(types).toContain("anthropic");
    expect(types).toContain("openai");
    expect(types).toContain("google");
    expect(types).toContain("openai-compatible");
  });

  it("isProviderRegistered 行为正确", () => {
    expect(isProviderRegistered("anthropic")).toBe(true);
    expect(isProviderRegistered("openai-compatible")).toBe(true);
    expect(isProviderRegistered("xxx-unknown")).toBe(false);
  });

  it("openai-compatible 不传 baseUrl → 抛错", () => {
    expect(() => getLanguageModel("openai-compatible", "deepseek-chat", "sk-test")).toThrow(
      /baseUrl|endpoint/,
    );
  });

  it("openai-compatible 传 baseUrl → 正常返回（Vercel AI SDK 内部用，没真发请求）", () => {
    const lm = getLanguageModel("openai-compatible", "deepseek-chat", "sk-test", "https://api.deepseek.com/v1");
    expect(lm).toBeDefined();
  });
});
