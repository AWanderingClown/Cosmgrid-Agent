import { describe, expect, it } from "vitest";
import { capitalizeFirstLetter, groupModelsForPicker } from "../model-picker-groups";
import type { ModelListItem } from "@/lib/api";

function model(overrides: Partial<ModelListItem> & { id: string; providerId: string }): ModelListItem {
  return {
    name: overrides.name ?? "model",
    displayName: overrides.displayName ?? null,
    contextWindow: null,
    inputPrice: null,
    outputPrice: null,
    enabled: true,
    workRoles: "[]",
    capabilityScore: null,
    provider: overrides.provider,
    ...overrides,
  };
}

describe("model-picker-groups", () => {
  it("单模型供应商保持扁平（不额外多一层点击）", () => {
    const models = [
      model({ id: "m1", providerId: "p1", name: "MiniMax-M3", provider: { name: "MiniMax", type: "openai-compatible" } }),
      model({ id: "m2", providerId: "p2", name: "deepseek-chat", provider: { name: "DeepSeek", type: "openai-compatible" } }),
    ];
    const entries = groupModelsForPicker(models);
    expect(entries).toEqual([
      { kind: "flat", model: models[0] },
      { kind: "flat", model: models[1] },
    ]);
  });

  it("同一供应商挂多个模型时折叠成二级分组，顶层用短名（claude-cli -> Claude）", () => {
    const models = [
      model({ id: "sonnet", providerId: "claude-provider", name: "sonnet", displayName: "Sonnet", provider: { name: "Claude Code (CLI 订阅)", type: "claude-cli" } }),
      model({ id: "opus", providerId: "claude-provider", name: "opus", displayName: "Opus", provider: { name: "Claude Code (CLI 订阅)", type: "claude-cli" } }),
      model({ id: "haiku", providerId: "claude-provider", name: "haiku", displayName: "Haiku", provider: { name: "Claude Code (CLI 订阅)", type: "claude-cli" } }),
    ];
    const entries = groupModelsForPicker(models);
    expect(entries).toEqual([
      {
        kind: "group",
        providerId: "claude-provider",
        label: "Claude",
        models,
      },
    ]);
  });

  it("codex-cli 短名是 Codex", () => {
    const models = [
      model({ id: "a", providerId: "codex-provider", name: "gpt-5.5", provider: { name: "Codex (CLI 订阅)", type: "codex-cli" } }),
      model({ id: "b", providerId: "codex-provider", name: "gpt-5.5-mini", provider: { name: "Codex (CLI 订阅)", type: "codex-cli" } }),
    ];
    const entries = groupModelsForPicker(models);
    expect(entries[0]).toMatchObject({ kind: "group", label: "Codex" });
  });

  it("未知供应商类型（普通 API 供应商但意外挂了多个模型）落回 provider.name", () => {
    const models = [
      model({ id: "a", providerId: "p", name: "m-a", provider: { name: "Custom Vendor", type: "openai-compatible" } }),
      model({ id: "b", providerId: "p", name: "m-b", provider: { name: "Custom Vendor", type: "openai-compatible" } }),
    ];
    const entries = groupModelsForPicker(models);
    expect(entries[0]).toMatchObject({ kind: "group", label: "Custom Vendor" });
  });

  it("保留模型原始出现顺序分配分组位置", () => {
    const models = [
      model({ id: "a", providerId: "p1", name: "a", provider: { name: "P1", type: "openai-compatible" } }),
      model({ id: "b", providerId: "p2", name: "b", provider: { name: "P2", type: "openai-compatible" } }),
      model({ id: "c", providerId: "p1", name: "c", provider: { name: "P1", type: "openai-compatible" } }),
    ];
    const entries = groupModelsForPicker(models);
    expect(entries.map((e) => (e.kind === "flat" ? e.model.id : e.providerId))).toEqual(["p1", "b"]);
    expect(entries[0]).toMatchObject({ kind: "group", providerId: "p1" });
  });

  it("capitalizeFirstLetter 只大写首字母，保留其余原样", () => {
    expect(capitalizeFirstLetter("sonnet")).toBe("Sonnet");
    expect(capitalizeFirstLetter("gpt-5.5")).toBe("Gpt-5.5");
    expect(capitalizeFirstLetter("")).toBe("");
  });
});
