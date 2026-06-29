import { describe, it, expect } from "vitest";
import { PROVIDER_PRESETS, getPresetById } from "../provider-presets";

describe("provider-presets", () => {
  it("覆盖约定的厂商（国内5 + 国外3 + CLI2）", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    for (const id of ["deepseek", "zhipu", "qwen", "kimi", "minimax", "agnes", "openai", "anthropic", "gemini", "claude-cli", "codex-cli"]) {
      expect(ids).toContain(id);
    }
  });

  it("id 唯一", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("非 CLI 厂商必须有 baseUrl 和默认模型；CLI 的 baseUrl 留空", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.defaultModel.length).toBeGreaterThan(0);
      if (p.providerType === "claude-cli" || p.providerType === "codex-cli") {
        expect(p.baseUrl).toBe("");
        expect(p.supportsModelFetch).toBe(false);
      } else {
        expect(p.baseUrl).toMatch(/^https:\/\//);
        expect(p.supportsModelFetch).toBe(true);
      }
    }
  });

  it("DeepSeek 预设带核实过的 baseUrl（无 /v1）", () => {
    const ds = getPresetById("deepseek");
    expect(ds?.baseUrl).toBe("https://api.deepseek.com");
    expect(ds?.providerType).toBe("openai-compatible");
  });

  it("CLI 预设不要求用户填写路径和价格，Codex 默认使用 GPT 5.5 元数据", () => {
    const codex = getPresetById("codex-cli");
    expect(codex).toMatchObject({
      providerType: "codex-cli",
      baseUrl: "",
      defaultModel: "gpt-5.5",
      defaultDisplayName: "GPT 5.5",
      defaultContextWindow: 1_050_000,
      supportsModelFetch: false,
    });
    const claude = getPresetById("claude-cli");
    expect(claude).toMatchObject({
      providerType: "claude-cli",
      baseUrl: "",
      defaultModel: "sonnet",
      defaultDisplayName: "Claude Sonnet",
      defaultContextWindow: 1_000_000,
      supportsModelFetch: false,
    });
  });

  it("getPresetById 找不到返回 undefined", () => {
    expect(getPresetById("nope")).toBeUndefined();
  });
});
