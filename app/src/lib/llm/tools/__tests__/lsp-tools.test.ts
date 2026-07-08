import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkPath: vi.fn(),
  diagnostics: vi.fn(),
  definition: vi.fn(),
  hover: vi.fn(),
}));

vi.mock("../path-safety", () => ({ checkPath: mocks.checkPath }));
vi.mock("@/lib/lsp/lsp-session", () => ({
  getLspDiagnostics: mocks.diagnostics,
  getLspDefinition: mocks.definition,
  getLspHover: mocks.hover,
}));

const { lspDefinitionTool, lspDiagnosticsTool, lspHoverTool } = await import("../lsp-tools");

const ctx = { workspacePath: "/workspace" };

describe("LSP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkPath.mockResolvedValue({ ok: true, resolved: "/workspace/src/a.ts" });
  });

  it("returns denied without invoking LSP when path safety fails", async () => {
    mocks.checkPath.mockResolvedValue({ ok: false, reason: "outside workspace" });
    await expect(lspDiagnosticsTool.execute({ file_path: "../a.ts" }, ctx))
      .resolves.toEqual({ status: "denied", output: "outside workspace" });
    expect(mocks.diagnostics).not.toHaveBeenCalled();
  });

  it("runs diagnostics, definition, and hover with resolved paths", async () => {
    mocks.diagnostics.mockResolvedValue("diagnostics");
    mocks.definition.mockResolvedValue("definition");
    mocks.hover.mockResolvedValue("hover");

    await expect(lspDiagnosticsTool.execute({ file_path: "src/a.ts" }, ctx))
      .resolves.toEqual({ status: "success", output: "diagnostics" });
    await expect(lspDefinitionTool.execute({ file_path: "src/a.ts", line: 2, character: 3 }, ctx))
      .resolves.toEqual({ status: "success", output: "definition" });
    await expect(lspHoverTool.execute({ file_path: "src/a.ts", line: 4, character: 5 }, ctx))
      .resolves.toEqual({ status: "success", output: "hover" });

    expect(mocks.definition).toHaveBeenCalledWith("/workspace", "/workspace/src/a.ts", 2, 3);
    expect(mocks.hover).toHaveBeenCalledWith("/workspace", "/workspace/src/a.ts", 4, 5);
  });

  it("turns Error and non-Error failures into tool errors", async () => {
    mocks.diagnostics.mockRejectedValue(new Error("server stopped"));
    await expect(lspDiagnosticsTool.execute({ file_path: "src/a.ts" }, ctx))
      .resolves.toEqual({ status: "error", output: "LSP 查询失败：server stopped" });

    mocks.hover.mockRejectedValue("unknown failure");
    await expect(lspHoverTool.execute({ file_path: "src/a.ts", line: 1, character: 1 }, ctx))
      .resolves.toEqual({ status: "error", output: "LSP 查询失败：unknown failure" });
  });
});
