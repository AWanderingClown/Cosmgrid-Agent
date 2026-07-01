import { describe, expect, it } from "vitest";
import type { CredentialListItem, ModelListItem } from "@/lib/api";
import type { ModelEndpoint } from "@/lib/llm/chat-fallback";
import { buildMainChatModelChain } from "../model-chain";

function model(id: string, providerId: string, providerType: string, name = id): ModelListItem {
  return {
    id,
    name,
    displayName: name,
    contextWindow: null,
    inputPrice: null,
    outputPrice: null,
    enabled: true,
    workRoles: JSON.stringify(["main_chat"]),
    capabilityScore: JSON.stringify({ main_chat: 80 }),
    providerId,
    provider: { name: providerId, type: providerType },
  };
}

function credential(id: string, providerId: string, providerType: string): CredentialListItem {
  return {
    id,
    name: id,
    baseUrl: "",
    enabled: true,
    providerId,
    provider: { name: providerId, type: providerType },
    defaultModelId: null,
  };
}

const toEndpoint = ((m: Pick<ModelListItem, "id" | "name" | "providerId" | "provider" | "displayName">, c: { id: string }, apiKey: string): ModelEndpoint => ({
  modelId: m.id,
  modelName: m.name,
  providerType: m.provider?.type ?? "",
  providerId: m.providerId,
  apiCredentialId: c.id,
  apiKey,
  displayLabel: m.displayName ?? m.name,
})) as never;

describe("buildMainChatModelChain", () => {
  it("keeps primary first and adds eligible API fallbacks with keys", async () => {
    const primary = model("primary", "p1", "openai");
    const fallback = model("fallback", "p2", "openai");
    const chain = await buildMainChatModelChain({
      primaryModel: primary,
      primaryCredential: credential("c1", "p1", "openai"),
      primaryApiKey: "primary-key",
      primaryIsCli: false,
      availableModels: [primary, fallback],
      credentials: [credential("c1", "p1", "openai"), credential("c2", "p2", "openai")],
      effectiveWorkspace: null,
      getApiKey: async (id) => (id === "c2" ? "fallback-key" : null),
      stopIfAborted: () => false,
      toEndpoint,
    });

    expect(chain.map((e) => [e.modelId, e.apiKey])).toEqual([
      ["primary", "primary-key"],
      ["fallback", "fallback-key"],
    ]);
  });

  it("skips CLI fallbacks for image turns and skips API fallbacks without keys", async () => {
    const primary = model("primary", "p1", "openai");
    const cliFallback = model("codex", "p2", "codex-cli");
    const apiWithoutKey = model("api-no-key", "p3", "openai");
    const chain = await buildMainChatModelChain({
      primaryModel: primary,
      primaryCredential: credential("c1", "p1", "openai"),
      primaryApiKey: "primary-key",
      primaryIsCli: false,
      availableModels: [primary, cliFallback, apiWithoutKey],
      credentials: [
        credential("c1", "p1", "openai"),
        credential("c2", "p2", "codex-cli"),
        credential("c3", "p3", "openai"),
      ],
      attachments: [{ id: "img", kind: "image", name: "shot.png", dataUrl: "data:image/png;base64,abc", mediaType: "image/png" }],
      effectiveWorkspace: null,
      getApiKey: async () => null,
      stopIfAborted: () => false,
      toEndpoint,
    });

    expect(chain.map((e) => e.modelId)).toEqual(["primary"]);
  });

  it("passes workspace directory to CLI endpoints", async () => {
    const primary = model("codex", "p1", "codex-cli");
    const chain = await buildMainChatModelChain({
      primaryModel: primary,
      primaryCredential: credential("c1", "p1", "codex-cli"),
      primaryApiKey: "",
      primaryIsCli: true,
      availableModels: [primary],
      credentials: [credential("c1", "p1", "codex-cli")],
      effectiveWorkspace: "/repo",
      getApiKey: async () => null,
      stopIfAborted: () => false,
      toEndpoint,
    });

    expect(chain).toHaveLength(1);
    expect(chain[0]?.workingDirectory).toBe("/repo");
  });
});
