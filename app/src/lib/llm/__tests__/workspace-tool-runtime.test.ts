import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildAiSdkTools: vi.fn(),
  createDefaultToolRegistry: vi.fn(),
  buildWorkspacePreamble: vi.fn(),
}));

vi.mock("../tools", () => ({
  buildAiSdkTools: mocks.buildAiSdkTools,
  createDefaultToolRegistry: mocks.createDefaultToolRegistry,
}));

vi.mock("../workspace-context", () => ({
  buildWorkspacePreamble: mocks.buildWorkspacePreamble,
}));

const { prepareWorkspaceToolRuntime } = await import("../workspace-tool-runtime");

describe("prepareWorkspaceToolRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createDefaultToolRegistry.mockReturnValue({ registry: true });
    mocks.buildAiSdkTools.mockReturnValue({ read: { description: "read" } });
    mocks.buildWorkspacePreamble.mockResolvedValue("workspace preamble");
  });

  it("没有 workspacePath 时不构造工具", async () => {
    const runtime = await prepareWorkspaceToolRuntime({ workspacePath: null, includeWrite: true });

    expect(runtime).toEqual({ workspacePreamble: null });
    expect(mocks.createDefaultToolRegistry).not.toHaveBeenCalled();
    expect(mocks.buildAiSdkTools).not.toHaveBeenCalled();
    expect(mocks.buildWorkspacePreamble).not.toHaveBeenCalled();
  });

  it("构造工具时透传工作区、确认回调和关联实体", async () => {
    const confirm = vi.fn();
    const runtime = await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: true,
      projectId: "proj-1",
      conversationId: "conv-1",
      confirm,
      blockedCommands: ["rm"],
    });

    expect(runtime.tools).toEqual({ read: { description: "read" } });
    expect(mocks.createDefaultToolRegistry).toHaveBeenCalledWith({ includeWrite: true });
    expect(mocks.buildAiSdkTools).toHaveBeenCalledWith({ registry: true }, {
      workspacePath: "/ws",
      projectId: "proj-1",
      conversationId: "conv-1",
      confirm,
      blockedCommands: ["rm"],
    });
    expect(mocks.buildWorkspacePreamble).not.toHaveBeenCalled();
  });

  it("项目说明读取失败不影响工具", async () => {
    mocks.buildWorkspacePreamble.mockRejectedValue(new Error("read failed"));

    const runtime = await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: false,
      includePreamble: true,
    });

    expect(runtime.tools).toEqual({ read: { description: "read" } });
    expect(runtime.workspacePreamble).toBeNull();
    expect(mocks.buildWorkspacePreamble).toHaveBeenCalledWith("/ws", { includeWrite: false });
  });

  it("工具构造失败不影响项目说明", async () => {
    mocks.buildAiSdkTools.mockImplementation(() => {
      throw new Error("tool failed");
    });

    const runtime = await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: false,
      includePreamble: true,
    });

    expect(runtime.tools).toBeUndefined();
    expect(runtime.workspacePreamble).toBe("workspace preamble");
    expect(mocks.buildWorkspacePreamble).toHaveBeenCalledWith("/ws", { includeWrite: false });
  });

  it("项目说明读取时透传 includeWrite", async () => {
    await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: true,
      includePreamble: true,
    });

    expect(mocks.buildWorkspacePreamble).toHaveBeenCalledWith("/ws", { includeWrite: true });
  });

  it("透传 desktopPath 给 buildWorkspacePreamble（让模型知道桌面在哪，能自己用 write 工具存桌面）", async () => {
    await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: true,
      includePreamble: true,
      desktopPath: "/Users/me/Desktop",
    });

    expect(mocks.buildWorkspacePreamble).toHaveBeenCalledWith("/ws", {
      includeWrite: true,
      desktopPath: "/Users/me/Desktop",
    });
  });
});
