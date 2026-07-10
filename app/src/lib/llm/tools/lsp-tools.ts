import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { getLspDefinition, getLspDiagnostics, getLspHover } from "@/lib/lsp/lsp-session";

const fileSchema = z.object({
  file_path: z.string().describe("要检查的源码文件路径（相对工作区或绝对路径）"),
});

const positionSchema = fileSchema.extend({
  line: z.number().int().min(1).describe("1-based 行号"),
  character: z.number().int().min(1).describe("1-based 列号"),
});

type FileParams = z.infer<typeof fileSchema>;
type PositionParams = z.infer<typeof positionSchema>;

async function withCheckedFile(
  ctx: { security?: { kind: string; resolved?: string } },
  run: (resolved: string) => Promise<string>,
): Promise<ToolResult> {
  if (ctx.security?.kind !== "read-path" || !ctx.security.resolved) {
    throw new Error("lsp 工具必须经 executeTool 调用（缺 ctx.security）");
  }
  try {
    return { status: "success", output: await run(ctx.security.resolved) };
  } catch (err) {
    return { status: "error", output: `LSP 查询失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export const lspDiagnosticsTool: ToolDefinition<FileParams> = {
  name: "lsp_diagnostics",
  description: "通过语言服务读取一个源码文件的诊断信息，比如 TypeScript 类型错误。",
  parameters: fileSchema,
  readOnly: true,
  security: { kind: "read-path", pathField: "file_path" },
  execute: (_input, ctx) => withCheckedFile(ctx, (resolved) => getLspDiagnostics(ctx.workspacePath, resolved)),
};

export const lspDefinitionTool: ToolDefinition<PositionParams> = {
  name: "lsp_definition",
  description: "通过语言服务查询指定源码位置的定义位置。line/character 都是 1-based。",
  parameters: positionSchema,
  readOnly: true,
  security: { kind: "read-path", pathField: "file_path" },
  execute: (input, ctx) => withCheckedFile(
    ctx,
    (resolved) => getLspDefinition(ctx.workspacePath, resolved, input.line, input.character),
  ),
};

export const lspHoverTool: ToolDefinition<PositionParams> = {
  name: "lsp_hover",
  description: "通过语言服务查询指定源码位置的类型/文档悬停信息。line/character 都是 1-based。",
  parameters: positionSchema,
  readOnly: true,
  security: { kind: "read-path", pathField: "file_path" },
  execute: (input, ctx) => withCheckedFile(
    ctx,
    (resolved) => getLspHover(ctx.workspacePath, resolved, input.line, input.character),
  ),
};
