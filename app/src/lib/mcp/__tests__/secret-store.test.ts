import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRow } from "@/lib/db/mcp";

const mocks = vi.hoisted(() => ({
  saveApiKey: vi.fn(),
  getApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  setSecretCredential: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/keystore", () => ({
  saveApiKey: mocks.saveApiKey,
  getApiKey: mocks.getApiKey,
  deleteApiKey: mocks.deleteApiKey,
}));

vi.mock("@/lib/db", () => ({
  mcpServers: {
    setSecretCredential: mocks.setSecretCredential,
    list: mocks.list,
  },
}));

const {
  deleteMcpServerSecrets,
  hydrateMcpServerSecrets,
  migrateLegacyMcpServerSecrets,
  saveMcpServerSecrets,
} = await import("../secret-store");

function server(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: "server-1",
    name: "test",
    transport: "remote_http",
    url: "https://example.test/mcp",
    command: null,
    args: [],
    env: {},
    headers: {},
    secretCredentialId: null,
    enabled: true,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("MCP secret store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores headers and env in the OS credential store and only persists a reference", async () => {
    mocks.saveApiKey.mockResolvedValue(undefined);
    mocks.setSecretCredential.mockResolvedValue(undefined);

    await saveMcpServerSecrets("server-1", {
      headers: { Authorization: "Bearer secret" },
      env: { TOKEN: "secret-env" },
    });

    expect(mocks.saveApiKey).toHaveBeenCalledWith(
      "mcp-server:server-1",
      JSON.stringify({
        headers: { Authorization: "Bearer secret" },
        env: { TOKEN: "secret-env" },
      }),
    );
    expect(mocks.setSecretCredential).toHaveBeenCalledWith("server-1", "mcp-server:server-1");
  });

  it("hydrates secrets from the credential store", async () => {
    mocks.getApiKey.mockResolvedValue(JSON.stringify({
      headers: { Authorization: "Bearer secret" },
      env: { TOKEN: "secret-env" },
    }));

    await expect(hydrateMcpServerSecrets(server({
      secretCredentialId: "mcp-server:server-1",
    }))).resolves.toMatchObject({
      headers: { Authorization: "Bearer secret" },
      env: { TOKEN: "secret-env" },
    });
  });

  it("deletes the credential when a server is removed", async () => {
    mocks.deleteApiKey.mockResolvedValue(undefined);
    await deleteMcpServerSecrets(server({ secretCredentialId: "mcp-server:server-1" }));
    expect(mocks.deleteApiKey).toHaveBeenCalledWith("mcp-server:server-1");
  });

  it("returns empty secrets for missing or malformed credential data", async () => {
    mocks.getApiKey.mockResolvedValueOnce(null);
    await expect(hydrateMcpServerSecrets(server({
      secretCredentialId: "mcp-server:server-1",
    }))).resolves.toMatchObject({ headers: {}, env: {} });

    mocks.getApiKey.mockResolvedValueOnce("{bad json");
    await expect(hydrateMcpServerSecrets(server({
      secretCredentialId: "mcp-server:server-1",
    }))).resolves.toMatchObject({ headers: {}, env: {} });
  });

  it("filters non-string values loaded from the credential store", async () => {
    mocks.getApiKey.mockResolvedValue(JSON.stringify({
      headers: { Good: "value", Bad: 123 },
      env: ["not", "a", "record"],
    }));
    await expect(hydrateMcpServerSecrets(server({
      secretCredentialId: "mcp-server:server-1",
    }))).resolves.toMatchObject({ headers: { Good: "value" }, env: {} });
  });

  it("migrates legacy SQLite secrets and skips already secure or empty rows", async () => {
    const legacy = server({ headers: { Authorization: "legacy" } });
    mocks.list.mockResolvedValue([
      legacy,
      server({ id: "secure", secretCredentialId: "mcp-server:secure" }),
      server({ id: "empty" }),
    ]);
    mocks.saveApiKey.mockResolvedValue(undefined);
    mocks.setSecretCredential.mockResolvedValue(undefined);

    await migrateLegacyMcpServerSecrets();
    expect(mocks.saveApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.saveApiKey).toHaveBeenCalledWith(
      "mcp-server:server-1",
      JSON.stringify({ headers: { Authorization: "legacy" }, env: {} }),
    );
  });

  it("does nothing when a server has no stored credential", async () => {
    await deleteMcpServerSecrets(server());
    expect(mocks.deleteApiKey).not.toHaveBeenCalled();
  });
});
