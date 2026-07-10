import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialListItem, ModelListItem } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  getLanguageModel: vi.fn(),
  resolveAuxiliaryModel: vi.fn(),
}));

vi.mock("@/lib/llm/provider-factory", () => ({
  getLanguageModel: mocks.getLanguageModel,
}));

vi.mock("@/lib/llm/auxiliary-model", () => ({
  resolveAuxiliaryModel: mocks.resolveAuxiliaryModel,
}));

import { prepareTurnModels } from "@/pages/chat/turn-model-preparation";

function model(providerType: string): ModelListItem {
  return {
    id: "model-1",
    name: "model-name",
    displayName: null,
    providerId: "provider-1",
    provider: { name: "Provider", type: providerType },
  } as ModelListItem;
}

function credential(): CredentialListItem {
  return {
    id: "credential-1",
    providerId: "provider-1",
    baseUrl: "https://example.com/v1",
  } as CredentialListItem;
}

describe("prepareTurnModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLanguageModel.mockReturnValue({ id: "intent-model" });
    mocks.resolveAuxiliaryModel.mockResolvedValue({ model: { id: "aux-model" } });
  });

  it("reports a missing credential before reading an API key", async () => {
    const getApiKey = vi.fn();

    const result = await prepareTurnModels({
      model: model("openai-compatible"),
      availableModels: [],
      credentials: [],
      getApiKey,
    });

    expect(result).toEqual({ ok: false, reason: "missing-credential" });
    expect(getApiKey).not.toHaveBeenCalled();
  });

  it("reports a missing key for an API model", async () => {
    const result = await prepareTurnModels({
      model: model("openai-compatible"),
      availableModels: [],
      credentials: [credential()],
      getApiKey: vi.fn().mockResolvedValue(null),
    });

    expect(result).toEqual({ ok: false, reason: "missing-api-key" });
    expect(mocks.getLanguageModel).not.toHaveBeenCalled();
  });

  it("does not read an API key or build an intent judge for CLI models", async () => {
    const getApiKey = vi.fn();

    const result = await prepareTurnModels({
      model: model("codex-cli"),
      availableModels: [model("codex-cli")],
      credentials: [credential()],
      getApiKey,
    });

    expect(result).toMatchObject({ ok: true, primaryIsCli: true, apiKey: "", intentJudgeModel: null });
    expect(getApiKey).not.toHaveBeenCalled();
    expect(mocks.getLanguageModel).not.toHaveBeenCalled();
    expect(mocks.resolveAuxiliaryModel).toHaveBeenCalledOnce();
  });

  it("keeps auxiliary judging available when the primary intent model cannot be built", async () => {
    mocks.getLanguageModel.mockImplementation(() => {
      throw new Error("unsupported provider");
    });

    const result = await prepareTurnModels({
      model: model("openai-compatible"),
      availableModels: [model("openai-compatible")],
      credentials: [credential()],
      getApiKey: vi.fn().mockResolvedValue("secret"),
    });

    expect(result).toMatchObject({
      ok: true,
      primaryIsCli: false,
      apiKey: "secret",
      intentJudgeModel: null,
      auxiliaryJudgeModel: { model: { id: "aux-model" } },
    });
  });
});
