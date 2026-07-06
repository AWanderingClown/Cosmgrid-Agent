import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URLS,
  getPresetForProviderType,
  inferRolesForModel,
  isCliType,
} from "../provider-form-defaults";

describe("provider-form-defaults", () => {
  it("maps CLI provider types to their own presets", () => {
    expect(getPresetForProviderType("claude-cli")).toMatchObject({
      id: "claude-cli",
      name: "Claude Code (CLI 订阅)",
      providerType: "claude-cli",
      defaultModel: "sonnet",
      defaultDisplayName: "Claude Sonnet",
    });
    expect(getPresetForProviderType("codex-cli")).toMatchObject({
      id: "codex-cli",
      name: "Codex (CLI 订阅)",
      providerType: "codex-cli",
      defaultModel: "gpt-5.5",
      defaultDisplayName: "GPT 5.5",
    });
  });

  it("keeps API providers out of CLI auto-preset mapping", () => {
    expect(getPresetForProviderType("anthropic")).toBeUndefined();
    expect(isCliType("anthropic")).toBe(false);
    expect(isCliType("codex-cli")).toBe(true);
  });

  it("leaves CLI executable path blank by default so runtime can auto-detect or use PATH", () => {
    expect(DEFAULT_BASE_URLS["claude-cli"]).toBe("");
    expect(DEFAULT_BASE_URLS["codex-cli"]).toBe("");
  });

  it("falls back to main chat when there is no model name", () => {
    expect(inferRolesForModel("")).toEqual(["main_chat"]);
  });
});
