import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRow } from "@/lib/db/mcp";
import { ToolRegistry } from "@/lib/llm/tools";

const mocks = vi.hoisted(() => ({
  listEnabled: vi.fn(),
  isApproved: vi.fn(),
  approve: vi.fn(),
  listMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  mcpServers: { listEnabled: mocks.listEnabled },
  mcpServerApprovals: {
    isApproved: mocks.isApproved,
    approve: mocks.approve,
  },
}));

vi.mock("../client", () => ({
  listMcpTools: mocks.listMcpTools,
  callMcpTool: mocks.callMcpTool,
}));

const { registerEnabledMcpTools } = await import("../register-tools");

function server(transport: McpServerRow["transport"]): McpServerRow {
  return {
    id: "server-1",
    name: "test",
    transport,
    url: transport === "remote_http" ? "https://example.test/mcp" : null,
    command: transport === "local_stdio" ? "node" : null,
    args: transport === "local_stdio" ? ["server.js"] : [],
    env: {},
    headers: {},
    secretCredentialId: null,
    enabled: true,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

describe("registerEnabledMcpTools local launch approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMcpTools.mockResolvedValue([]);
    mocks.isApproved.mockResolvedValue(false);
    mocks.approve.mockResolvedValue(undefined);
  });

  it("does not connect to an unapproved local server", async () => {
    mocks.listEnabled.mockResolvedValue([server("local_stdio")]);
    const approveLocalLaunch = vi.fn().mockResolvedValue(false);

    await registerEnabledMcpTools(new ToolRegistry(), {
      workspacePath: "/workspace-a",
      approveLocalLaunch,
    });

    expect(approveLocalLaunch).toHaveBeenCalledTimes(1);
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("connects after local launch approval", async () => {
    const local = server("local_stdio");
    mocks.listEnabled.mockResolvedValue([local]);
    const approveLocalLaunch = vi.fn().mockResolvedValue(true);

    await registerEnabledMcpTools(new ToolRegistry(), {
      workspacePath: "/workspace-a",
      approveLocalLaunch,
    });

    expect(mocks.listMcpTools).toHaveBeenCalledWith(local, "/workspace-a");
    expect(mocks.approve).toHaveBeenCalledWith(expect.objectContaining({
      serverId: local.id,
      workspacePath: "/workspace-a",
    }));
  });

  it("reuses a persisted approval for the same workspace and configuration", async () => {
    const local = server("local_stdio");
    mocks.listEnabled.mockResolvedValue([local]);
    mocks.isApproved.mockResolvedValue(true);
    const approveLocalLaunch = vi.fn();

    await registerEnabledMcpTools(new ToolRegistry(), {
      workspacePath: "/workspace-a",
      approveLocalLaunch,
    });

    expect(approveLocalLaunch).not.toHaveBeenCalled();
    expect(mocks.listMcpTools).toHaveBeenCalledWith(local, "/workspace-a");
  });

  it("does not request local launch approval for remote servers", async () => {
    const remote = server("remote_http");
    mocks.listEnabled.mockResolvedValue([remote]);
    const approveLocalLaunch = vi.fn();

    await registerEnabledMcpTools(new ToolRegistry(), {
      workspacePath: "/workspace-a",
      approveLocalLaunch,
    });

    expect(approveLocalLaunch).not.toHaveBeenCalled();
    expect(mocks.listMcpTools).toHaveBeenCalledWith(remote, "/workspace-a");
  });

  // 2026-07-15 review 修复回归测试：原来是 for...of 顺序 await，一个 server 卡住/报错会
  // 拖慢甚至（如果是真悬挂）挡住后面 server 的注册。改成 Promise.allSettled 并行后，一个
  // server 失败不应该影响另一个 server 正常注册工具，且两个 server 的 listMcpTools 都应该
  // 被调用到（不是顺序短路，第一个失败就不再试第二个）。
  it("一个 server 失败不阻塞另一个 server 的工具注册（并行，不是顺序短路）", async () => {
    const remoteA = { ...server("remote_http"), id: "server-a", name: "server-a" };
    const remoteB = { ...server("remote_http"), id: "server-b", name: "server-b" };
    mocks.listEnabled.mockResolvedValue([remoteA, remoteB]);
    mocks.isApproved.mockResolvedValue(true);

    mocks.listMcpTools.mockImplementation(async (s: McpServerRow) => {
      if (s.id === "server-a") throw new Error("server-a 卡住/连不上");
      return [{ name: "tool-b", description: "", inputSchema: { type: "object" as const } }];
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = new ToolRegistry();
    await registerEnabledMcpTools(registry, { workspacePath: "/workspace-a" });

    expect(mocks.listMcpTools).toHaveBeenCalledWith(remoteA, "/workspace-a");
    expect(mocks.listMcpTools).toHaveBeenCalledWith(remoteB, "/workspace-a");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("server-a"),
      expect.any(Error),
    );
    consoleErrorSpy.mockRestore();
  });
});
