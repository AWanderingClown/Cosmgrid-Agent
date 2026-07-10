import { describe, expect, it, vi } from "vitest";
import { buildApiModelEndpoints } from "../endpoint-list";

describe("buildApiModelEndpoints", () => {
  it("只返回有 provider、有 credential、有 key 的 API 模型", async () => {
    const endpoints = await buildApiModelEndpoints({
      availableModels: [
        {
          id: "api-1",
          name: "gpt-4.1-mini",
          displayName: "Mini",
          providerId: "p-openai",
          provider: { type: "openai", name: "OpenAI" },
        } as never,
        {
          id: "cli-1",
          name: "gpt-5-codex",
          displayName: "Codex",
          providerId: "p-codex",
          provider: { type: "codex-cli", name: "Codex CLI" },
        } as never,
        {
          id: "api-no-key",
          name: "gemini-2.5-flash",
          displayName: "Flash",
          providerId: "p-gemini",
          provider: { type: "google", name: "Google" },
        } as never,
      ],
      credentials: [
        { id: "cred-openai", providerId: "p-openai", baseUrl: null } as never,
        { id: "cred-gemini", providerId: "p-gemini", baseUrl: null } as never,
      ],
      getApiKey: vi.fn(async (credentialId: string) => (credentialId === "cred-openai" ? "sk-openai" : null)),
    });

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({
      modelId: "api-1",
      providerType: "openai",
      apiKey: "sk-openai",
    });
  });
});
