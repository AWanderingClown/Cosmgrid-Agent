import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDebateParticipants } from "@/lib/llm/debate-participants";
import { _resetCooldowns, markModelFailed } from "@/lib/llm/model-cooldown";
import type { CredentialListItem, ModelListItem } from "@/lib/api";

function model(overrides: Partial<ModelListItem> & { id: string; name: string; providerId: string }): ModelListItem {
  return {
    displayName: null,
    contextWindow: null,
    inputPrice: null,
    outputPrice: null,
    enabled: true,
    workRoles: "[]",
    capabilityScore: null,
    provider: { name: "Provider", type: "openai-compatible" },
    ...overrides,
  };
}

function credential(overrides: Partial<CredentialListItem> & { id: string; providerId: string }): CredentialListItem {
  return {
    name: "cred",
    baseUrl: "",
    enabled: true,
    provider: { name: "Provider", type: "openai-compatible" },
    defaultModelId: null,
    ...overrides,
  };
}

describe("buildDebateParticipants", () => {
  afterEach(() => {
    _resetCooldowns();
  });

  it("keeps scanning ranked candidates until it collects usable participants", async () => {
    const primary = model({
      id: "primary",
      name: "MiniMax-M3",
      providerId: "minimax",
      provider: { name: "MiniMax", type: "openai-compatible" },
    });
    const unavailableTopCandidate = model({
      id: "unavailable",
      name: "gpt-5",
      providerId: "missing-credential",
      provider: { name: "Missing", type: "openai-compatible" },
    });
    const codex = model({
      id: "codex",
      name: "gpt-5.5",
      providerId: "codex-provider",
      provider: { name: "Codex", type: "codex-cli" },
    });
    const credentials = [
      credential({ id: "cred-minimax", providerId: "minimax" }),
      credential({
        id: "cred-codex",
        providerId: "codex-provider",
        provider: { name: "Codex", type: "codex-cli" },
      }),
    ];

    const participants = await buildDebateParticipants({
      primaryModel: primary,
      availableModels: [primary, unavailableTopCandidate, codex],
      credentials,
      effectiveWorkspace: "/tmp/project",
      getApiKey: vi.fn(async (id: string) => (id === "cred-minimax" ? "sk-minimax" : null)),
      maxParticipants: 2,
    });

    expect(participants.map((p) => p.modelId)).toEqual(["codex", "primary"]);
    expect(participants[0]).toMatchObject({
      providerType: "codex-cli",
      apiKey: "",
      workingDirectory: "/tmp/project",
    });
  });

  it("prioritizes Claude CLI first, Codex CLI second, and API models last", async () => {
    const primary = model({
      id: "primary",
      name: "MiniMax-M3",
      providerId: "minimax",
      provider: { name: "MiniMax", type: "openai-compatible" },
    });
    const codexStrong = model({
      id: "codex-strong",
      name: "gpt-5.5",
      providerId: "codex-provider",
      provider: { name: "Codex", type: "codex-cli" },
    });
    const codexMini = model({
      id: "codex-mini",
      name: "gpt-5.4-mini",
      providerId: "codex-provider",
      provider: { name: "Codex", type: "codex-cli" },
    });
    const claudeOpus = model({
      id: "claude-opus",
      name: "claude-opus-4-8",
      providerId: "claude-provider",
      provider: { name: "Claude", type: "claude-cli" },
    });
    const credentials = [
      credential({ id: "cred-minimax", providerId: "minimax" }),
      credential({
        id: "cred-codex",
        providerId: "codex-provider",
        provider: { name: "Codex", type: "codex-cli" },
      }),
      credential({
        id: "cred-claude",
        providerId: "claude-provider",
        provider: { name: "Claude", type: "claude-cli" },
      }),
    ];

    const participants = await buildDebateParticipants({
      primaryModel: primary,
      availableModels: [primary, claudeOpus, codexMini, codexStrong],
      credentials,
      effectiveWorkspace: "/tmp/project",
      getApiKey: vi.fn(async (id: string) => (id === "cred-minimax" ? "sk-minimax" : null)),
      maxParticipants: 4,
    });

    expect(participants.map((p) => p.modelId)).toEqual([
      "claude-opus",
      "codex-strong",
      "codex-mini",
      "primary",
    ]);
  });

  it("skips models that are cooling down after a recent failure", async () => {
    const primary = model({
      id: "primary",
      name: "MiniMax-M3",
      providerId: "minimax",
      provider: { name: "MiniMax", type: "openai-compatible" },
    });
    const claudeOpus = model({
      id: "claude-opus",
      name: "claude-opus-4-8",
      providerId: "claude-provider",
      provider: { name: "Claude", type: "claude-cli" },
    });
    const codex = model({
      id: "codex",
      name: "gpt-5.5",
      providerId: "codex-provider",
      provider: { name: "Codex", type: "codex-cli" },
    });
    const credentials = [
      credential({ id: "cred-minimax", providerId: "minimax" }),
      credential({
        id: "cred-claude",
        providerId: "claude-provider",
        provider: { name: "Claude", type: "claude-cli" },
      }),
      credential({
        id: "cred-codex",
        providerId: "codex-provider",
        provider: { name: "Codex", type: "codex-cli" },
      }),
    ];
    markModelFailed("claude-opus");

    const participants = await buildDebateParticipants({
      primaryModel: primary,
      availableModels: [primary, claudeOpus, codex],
      credentials,
      effectiveWorkspace: "/tmp/project",
      getApiKey: vi.fn(async (id: string) => (id === "cred-minimax" ? "sk-minimax" : null)),
      maxParticipants: 3,
    });

    expect(participants.map((p) => p.modelId)).toEqual(["codex", "primary"]);
  });
});
