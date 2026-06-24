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

  // 回归：@ai-sdk/openai 3.x 的 provider(id) 默认走 Responses API(/responses)，DeepSeek/GLM/Qwen 等只有
  // /chat/completions → 一律 404 误报"模型不存在"。必须用 .chat()。锁死端点是 chat 而非 responses。
  it("openai-compatible 走 chat 补全端点（不是 responses）", () => {
    const lm = getLanguageModel("openai-compatible", "deepseek-chat", "sk-test", "https://api.deepseek.com") as { provider: string };
    expect(lm.provider).toContain("chat");
    expect(lm.provider).not.toContain("responses");
  });

  it("原生 openai 同样走 chat 补全端点", () => {
    const lm = getLanguageModel("openai", "gpt-4o", "sk-test") as { provider: string };
    expect(lm.provider).toContain("chat");
    expect(lm.provider).not.toContain("responses");
  });
});
