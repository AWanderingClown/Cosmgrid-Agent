import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLanguageModel: vi.fn(),
}));

vi.mock("../provider-factory", () => ({
  getLanguageModel: mocks.getLanguageModel,
}));

import { resolveAuxiliaryModel } from "../auxiliary-model";

const apiModel = (id: string, name = id) => ({
  id,
  name,
  providerId: `${id}-provider`,
  provider: { type: "openai", name: "OpenAI" },
});

const cliModel = {
  id: "codex-cli",
  name: "gpt-5-codex",
  providerId: "codex-provider",
  provider: { type: "codex-cli", name: "Codex CLI" },
};

describe("resolveAuxiliaryModel", () => {
  beforeEach(() => {
    mocks.getLanguageModel.mockReset().mockImplementation((providerType: string, modelName: string) => ({
      providerType,
      modelName,
    }));
  });

  it("只看 API 模型，忽略 CLI 模型", async () => {
    const resolved = await resolveAuxiliaryModel({
      availableModels: [cliModel as never, apiModel("cheap") as never],
      credentials: [{ id: "cred-cheap", providerId: "cheap-provider", baseUrl: null } as never],
      getApiKey: vi.fn(async () => "sk-cheap"),
    });

    expect(resolved?.modelId).toBe("cheap");
    expect(mocks.getLanguageModel).toHaveBeenCalledWith("openai", "cheap", "sk-cheap", null);
  });

  it("preferredModelId 有 key 时优先命中", async () => {
    const resolved = await resolveAuxiliaryModel({
      availableModels: [apiModel("cheap") as never, apiModel("preferred") as never],
      credentials: [
        { id: "cred-cheap", providerId: "cheap-provider", baseUrl: null } as never,
        { id: "cred-preferred", providerId: "preferred-provider", baseUrl: "https://example.com/v1" } as never,
      ],
      getApiKey: vi.fn(async (credId: string) => (credId === "cred-preferred" ? "sk-preferred" : "sk-cheap")),
      preferredModelId: "preferred",
    });

    expect(resolved?.modelId).toBe("preferred");
    expect(mocks.getLanguageModel).toHaveBeenCalledWith(
      "openai",
      "preferred",
      "sk-preferred",
      "https://example.com/v1",
    );
  });

  it("preferredModelId 没 key 时回退到其他 API 模型", async () => {
    const resolved = await resolveAuxiliaryModel({
      availableModels: [apiModel("cheap") as never, apiModel("preferred") as never],
      credentials: [
        { id: "cred-cheap", providerId: "cheap-provider", baseUrl: null } as never,
        { id: "cred-preferred", providerId: "preferred-provider", baseUrl: null } as never,
      ],
      getApiKey: vi.fn(async (credId: string) => (credId === "cred-cheap" ? "sk-cheap" : null)),
      preferredModelId: "preferred",
    });

    expect(resolved?.modelId).toBe("cheap");
  });

  it("没有任何可用 API key 时返回 null", async () => {
    const resolved = await resolveAuxiliaryModel({
      availableModels: [apiModel("cheap") as never],
      credentials: [{ id: "cred-cheap", providerId: "cheap-provider", baseUrl: null } as never],
      getApiKey: vi.fn(async () => null),
    });

    expect(resolved).toBeNull();
  });
});
