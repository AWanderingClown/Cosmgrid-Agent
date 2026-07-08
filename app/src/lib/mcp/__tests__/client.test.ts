import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRow } from "@/lib/db/mcp";

const mocks = vi.hoisted(() => ({
  listRemote: vi.fn(),
  callRemote: vi.fn(),
  disposeRemote: vi.fn(),
  disposeRemoteServer: vi.fn(),
  transports: [] as Array<{ options: Record<string, unknown>; dispose: ReturnType<typeof vi.fn> }>,
}));

vi.mock("../remote-client", () => ({
  listRemoteMcpTools: mocks.listRemote,
  callRemoteMcpTool: mocks.callRemote,
  disposeRemoteMcpSessions: mocks.disposeRemote,
  disposeRemoteMcpServerSessions: mocks.disposeRemoteServer,
  listAllRemoteTools: async (client: { listTools: (params?: unknown) => Promise<{ tools?: unknown[] }> }) => (
    (await client.listTools()).tools ?? []
  ),
}));

vi.mock("@/lib/rpc/tauri-transport", () => ({
  TauriRpcTransport: class {
    private listener: ((message: unknown) => void) | null = null;
    dispose = vi.fn(async () => undefined);

    constructor(readonly options: Record<string, unknown>) {
      mocks.transports.push(this);
    }

    onMessage(listener: (message: unknown) => void) {
      this.listener = listener;
    }

    onClose() {}
    onError() {}
    async start() {}

    async send(raw: unknown) {
      const message = raw as { id?: number; method?: string };
      if (message.id === undefined) return;
      let result: unknown = {};
      if (message.method === "tools/list") {
        result = { tools: [{ name: "local_echo", inputSchema: { type: "object" } }] };
      } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: "local result" }] };
      }
      queueMicrotask(() => this.listener?.({ jsonrpc: "2.0", id: message.id, result }));
    }
  },
}));

const {
  callMcpTool,
  disposeAllMcpSessions,
  disposeMcpServerSessions,
  listMcpTools,
} = await import("../client");

function server(transport: McpServerRow["transport"]): McpServerRow {
  return {
    id: `${transport}-server`,
    name: "test",
    transport,
    url: transport === "remote_http" ? "https://example.test/mcp" : null,
    command: transport === "local_stdio" ? "node" : null,
    args: ["server.js"],
    env: {},
    headers: {},
    secretCredentialId: null,
    enabled: true,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

describe("MCP client routing and lifecycle", () => {
  beforeEach(async () => {
    await disposeAllMcpSessions();
    vi.clearAllMocks();
    mocks.transports.length = 0;
    mocks.listRemote.mockResolvedValue([{ name: "remote_echo" }]);
    mocks.callRemote.mockResolvedValue({ content: [{ type: "text", text: "remote result" }] });
  });

  it("delegates remote list and call to the official transport client", async () => {
    const remote = server("remote_http");
    await expect(listMcpTools(remote)).resolves.toEqual([{ name: "remote_echo" }]);
    await expect(callMcpTool(remote, "echo", { value: 1 })).resolves.toMatchObject({
      content: [{ text: "remote result" }],
    });
    expect(mocks.listRemote).toHaveBeenCalledWith(remote);
    expect(mocks.callRemote).toHaveBeenCalledWith(remote, "echo", { value: 1 });
  });

  it("creates isolated local sessions per workspace and calls tools", async () => {
    const local = server("local_stdio");
    await expect(listMcpTools(local, "/workspace-a")).resolves.toEqual([
      { name: "local_echo", inputSchema: { type: "object" } },
    ]);
    await listMcpTools(local, "/workspace-b");
    expect(mocks.transports).toHaveLength(2);
    expect(mocks.transports[0]!.options.cwd).toBe("/workspace-a");
    expect(mocks.transports[1]!.options.cwd).toBe("/workspace-b");

    await expect(callMcpTool(local, "local_echo", {}, "/workspace-a")).resolves.toMatchObject({
      content: [{ text: "local result" }],
    });
  });

  it("disposes one server or all sessions", async () => {
    const local = server("local_stdio");
    await listMcpTools(local, "/workspace-a");
    await disposeMcpServerSessions(local.id);
    expect(mocks.transports[0]!.dispose).toHaveBeenCalled();
    expect(mocks.disposeRemoteServer).toHaveBeenCalledWith(local.id);

    await listMcpTools(local, "/workspace-b");
    await disposeAllMcpSessions();
    expect(mocks.transports[1]!.dispose).toHaveBeenCalled();
    expect(mocks.disposeRemote).toHaveBeenCalled();
  });
});
