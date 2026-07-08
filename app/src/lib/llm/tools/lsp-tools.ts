import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { checkPath } from "./path-safety";
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

async function withCheckedFile<T extends FileParams>(
  input: T,
  ctx: { workspacePath: string },
  run: (resolved: string) => Promise<string>,
): Promise<ToolResult> {
  const check = await checkPath(ctx.workspacePath, input.file_path);
  if (!check.ok) return { status: "denied", output: check.reason ?? "路径不允许" };
  try {
    return { status: "success", output: await run(check.resolved) };
  } catch (err) {
    return { status: "error", output: `LSP 查询失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export const lspDiagnosticsTool: ToolDefinition<FileParams> = {
  name: "lsp_diagnostics",
  description: "通过语言服务读取一个源码文件的诊断信息，比如 TypeScript 类型错误。",
  parameters: fileSchema,
  readOnly: true,
  execute: (input, ctx) => withCheckedFile(input, ctx, (resolved) => getLspDiagnostics(ctx.workspacePath, resolved)),
};

export const lspDefinitionTool: ToolDefinition<PositionParams> = {
  name: "lsp_definition",
  description: "通过语言服务查询指定源码位置的定义位置。line/character 都是 1-based。",
  parameters: positionSchema,
  readOnly: true,
  execute: (input, ctx) => withCheckedFile(
    input,
    ctx,
    (resolved) => getLspDefinition(ctx.workspacePath, resolved, input.line, input.character),
  ),
};

export const lspHoverTool: ToolDefinition<PositionParams> = {
  name: "lsp_hover",
  description: "通过语言服务查询指定源码位置的类型/文档悬停信息。line/character 都是 1-based。",
  parameters: positionSchema,
  readOnly: true,
  execute: (input, ctx) => withCheckedFile(
    input,
    ctx,
    (resolved) => getLspHover(ctx.workspacePath, resolved, input.line, input.character),
  ),
};
