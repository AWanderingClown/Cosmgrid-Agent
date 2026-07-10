import { beforeEach, describe, expect, it, vi } from "vitest";

// L6 安全网收拢（2026-07-09）：checkPath 现在由 executor 按 tool.security 声明统一跑，
// lsp-tools.ts 自己不再调用 path-safety——测试改走 executeTool + 真实 checkPath
// （不再 mock path-safety），越界拒绝靠真实工作区边界比较产生，跟生产路径一致。
const mocks = vi.hoisted(() => ({
  diagnostics: vi.fn(),
  definition: vi.fn(),
  hover: vi.fn(),
}));

vi.mock("../../../db", () => ({
  toolExecutions: { create: vi.fn().mockResolvedValue("id") },
}));
vi.mock("@/lib/lsp/lsp-session", () => ({
  getLspDiagnostics: mocks.diagnostics,
  getLspDefinition: mocks.definition,
  getLspHover: mocks.hover,
}));

const { lspDefinitionTool, lspDiagnosticsTool, lspHoverTool } = await import("../lsp-tools");
const { executeTool } = await import("../executor");

const ctx = { workspacePath: "/workspace" };

describe("LSP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns denied without invoking LSP when path safety fails", async () => {
    await expect(executeTool(lspDiagnosticsTool, { file_path: "../a.ts" }, ctx))
      .resolves.toMatchObject({ status: "denied" });
    expect(mocks.diagnostics).not.toHaveBeenCalled();
  });

  it("runs diagnostics, definition, and hover with resolved paths", async () => {
    // 阶段2（2026-07-11）：lsp_diagnostics 干净路径返回空字符串（"no diagnostics"），
    // 有问题才返回具体诊断文本。Stub 用空字符串代表干净，更接近生产语义。
    mocks.diagnostics.mockResolvedValue("no diagnostics");
    mocks.definition.mockResolvedValue("definition");
    mocks.hover.mockResolvedValue("hover");

    await expect(executeTool(lspDiagnosticsTool, { file_path: "src/a.ts" }, ctx))
      .resolves.toMatchObject({ status: "success", output: "no diagnostics" });
    await expect(executeTool(lspDefinitionTool, { file_path: "src/a.ts", line: 2, character: 3 }, ctx))
      .resolves.toMatchObject({ status: "success", output: "definition" });
    await expect(executeTool(lspHoverTool, { file_path: "src/a.ts", line: 4, character: 5 }, ctx))
      .resolves.toMatchObject({ status: "success", output: "hover" });

    expect(mocks.definition).toHaveBeenCalledWith("/workspace", "/workspace/src/a.ts", 2, 3);
    expect(mocks.hover).toHaveBeenCalledWith("/workspace", "/workspace/src/a.ts", 4, 5);
  });

  it("turns Error and non-Error failures into tool errors", async () => {
    mocks.diagnostics.mockRejectedValue(new Error("server stopped"));
    await expect(executeTool(lspDiagnosticsTool, { file_path: "src/a.ts" }, ctx))
      .resolves.toMatchObject({ status: "error", output: "LSP 查询失败：server stopped" });

    mocks.hover.mockRejectedValue("unknown failure");
    await expect(executeTool(lspHoverTool, { file_path: "src/a.ts", line: 1, character: 1 }, ctx))
      .resolves.toMatchObject({ status: "error", output: "LSP 查询失败：unknown failure" });
  });
});
