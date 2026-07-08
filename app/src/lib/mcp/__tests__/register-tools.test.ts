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
});
