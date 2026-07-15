import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRow } from "@/lib/db/mcp";

const mocks = vi.hoisted(() => ({
  listRemote: vi.fn(),
  callRemote: vi.fn(),
  disposeRemote: vi.fn(),
  disposeRemoteServer: vi.fn(),
  hasRemote: vi.fn(() => false),
  transports: [] as Array<{ options: Record<string, unknown>; dispose: ReturnType<typeof vi.fn>; simulateTerminated: () => void }>,
}));

vi.mock("../remote-client", () => ({
  listRemoteMcpTools: mocks.listRemote,
  callRemoteMcpTool: mocks.callRemote,
  disposeRemoteMcpSessions: mocks.disposeRemote,
  disposeRemoteMcpServerSessions: mocks.disposeRemoteServer,
  hasRemoteMcpSessions: mocks.hasRemote,
  listAllRemoteTools: async (client: { listTools: (params?: unknown) => Promise<{ tools?: unknown[] }> }) => (
    (await client.listTools()).tools ?? []
  ),
}));

vi.mock("@/lib/rpc/tauri-transport", () => ({
  TauriRpcTransport: class {
    private listener: ((message: unknown) => void) | null = null;
    private closeListeners: Array<() => void> = [];
    dispose = vi.fn(async () => undefined);

    constructor(readonly options: Record<string, unknown>) {
      mocks.transports.push(this);
    }

    onMessage(listener: (message: unknown) => void) {
      this.listener = listener;
    }

    onClose(listener: () => void) {
      this.closeListeners.push(listener);
    }
    onError() {}
    async start() {}

    /** 测试用：模拟进程终止，触发 onDead 让会话缓存 evict 自己。 */
    simulateTerminated() {
      for (const l of this.closeListeners) l();
    }

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
  hasKnownMcpSessions,
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
    mocks.hasRemote.mockReturnValue(false);
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

  // 2026-07-15 review 修复回归测试：进程崩溃/被 kill 后，之前 localSessions 缓存的条目原样
  // 留着指向已死的 client/transport，之后同 workspace 的调用会一直复用这个死会话，用户
  // 必须重启 app 才能恢复。现在 transport 报 terminated 后应该把缓存 evict，下一次调用会
  // 重新 spawn 一个全新的 transport。
  it("transport 报 terminated 后应该从缓存 evict，下次调用重新建会话而不是复用死会话", async () => {
    const local = server("local_stdio");
    await listMcpTools(local, "/workspace-a");
    expect(mocks.transports).toHaveLength(1);

    // 模拟进程被杀（比如 write_rpc_stdin 超时自动终止）
    mocks.transports[0]!.simulateTerminated();

    await listMcpTools(local, "/workspace-a");
    // evict 生效：第二次调用应该重新建了一个新 transport，不是复用第一次那个
    expect(mocks.transports).toHaveLength(2);
  });
});

describe("hasKnownMcpSessions（2026-07-13 真实事故回归测试）", () => {
  beforeEach(async () => {
    await disposeAllMcpSessions();
    vi.clearAllMocks();
    mocks.transports.length = 0;
    mocks.listRemote.mockResolvedValue([{ name: "remote_echo" }]);
    mocks.callRemote.mockResolvedValue({ content: [{ type: "text", text: "remote result" }] });
    mocks.hasRemote.mockReturnValue(false);
  });

  it("从没调用过任何 MCP 工具时为 false", () => {
    expect(hasKnownMcpSessions()).toBe(false);
  });

  it("列举过本地 stdio 工具（顺带触发 loadRemoteClient）、本地会话已清理、没有真实远程会话 → false（修复前只要 loadRemoteClient 被调用过一次就会永久误判为 true，导致关闭应用永远走清理慢路径）", async () => {
    const local = server("local_stdio");
    await listMcpTools(local, "/workspace-a");
    // listMcpTools 对本地 server 内部也会 loadRemoteClient()（见 client.ts 第85行）；
    // 清空本地会话后，只要 hasKnownMcpSessions() 还在用"模块加载过没有"当信号，就会
    // 一直误判为 true——即使这里的本地会话已经清干净、也没有任何真实远程会话。
    await disposeAllMcpSessions();
    expect(hasKnownMcpSessions()).toBe(false);
  });

  it("本地会话仍在（没 dispose）→ true", async () => {
    const local = server("local_stdio");
    await listMcpTools(local, "/workspace-a");
    expect(hasKnownMcpSessions()).toBe(true);
  });

  it("真实远程会话存在（hasRemoteMcpSessions 返回 true）→ true", async () => {
    const remote = server("remote_http");
    await listMcpTools(remote);
    mocks.hasRemote.mockReturnValue(true);
    expect(hasKnownMcpSessions()).toBe(true);
  });
});
