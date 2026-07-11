import { describe, expect, it } from "vitest";

import {
  applyToPrompt,
  applyToRetryPolicy,
  applyToToolDescriptions,
  applyToToolResultRenderer,
} from "../apply";
import type { ResolvedModelHarnessProfile } from "../types";

function profile(overrides: Partial<ResolvedModelHarnessProfile> = {}): ResolvedModelHarnessProfile {
  return {
    profile: {
      id: "p1",
      modelId: "m1",
      modelName: "model",
      providerId: null,
      providerType: null,
      versionRange: null,
      harnessVersionMin: null,
      harnessVersionMax: null,
      enabled: true,
      createdAt: "",
      updatedAt: "",
    },
    events: [],
    mergedAdaptations: [],
    ...overrides,
  };
}

describe("model profile apply helpers", () => {
  it("adds model-specific skill instructions to the prompt only", () => {
    const out = applyToPrompt(profile({
      mergedAdaptations: [{ kind: "skill_instruction", content: "必须先调用工具。", tags: ["tool"] }],
    }), "base");

    expect(out).toContain("base");
    expect(out).toContain("必须先调用工具。");
  });

  it("overrides tool descriptions without touching security-sensitive fields", () => {
    const registry = [{
      name: "bash",
      description: "old",
      readOnly: false,
      security: { confirm: true },
      parameters: { type: "object" },
    }];

    const [tool] = applyToToolDescriptions(profile({
      mergedAdaptations: [{
        kind: "tool_description_override",
        toolName: "bash",
        descriptionOverride: "new",
      }],
    }), registry);

    expect(tool.description).toBe("new");
    expect(tool.readOnly).toBe(false);
    expect(tool.security).toEqual({ confirm: true });
    expect(tool.parameters).toEqual({ type: "object" });
  });

  it("appends tool result hints without hiding the original result", () => {
    const render = applyToToolResultRenderer(profile({
      mergedAdaptations: [{ kind: "tool_result_format_hint", templateKey: "k", snippet: "next step" }],
    }), () => "raw result");

    expect(render({})).toContain("raw result");
    expect(render({})).toContain("next step");
  });

  it("applies retry overrides within the allowed policy surface", () => {
    const policy = applyToRetryPolicy(profile({
      mergedAdaptations: [{ kind: "retry_policy_override", maxRetries: 1 }],
    }), { maxRetries: 3, maxContextOverflowRetries: 1 });

    expect(policy).toEqual({ maxRetries: 1, maxContextOverflowRetries: 1 });
  });
});
