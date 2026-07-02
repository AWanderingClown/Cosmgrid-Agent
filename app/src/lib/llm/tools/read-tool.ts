// v0.7 阶段4 — read 工具（US-4.1：AI 读用户项目文件）
//
// 对齐 Claude Code 的 Read：{ file_path, offset?, limit? }，输出带行号，大文件截断。

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { checkPath } from "./path-safety";
import { getFsAdapter } from "./fs-adapter";

/** 默认最多读 200 行（大文件截断，避免撑爆上下文） */
const READ_DEFAULT_LIMIT = 200;

const paramsSchema = z.object({
  file_path: z.string().describe("要读取的文件路径（相对工作区或绝对路径）"),
  offset: z.number().int().min(1).optional().describe("起始行号（1-based）"),
  limit: z.number().int().min(1).optional().describe("最多读取的行数"),
});

type ReadParams = z.infer<typeof paramsSchema>;

/** 给每行加行号（cat -n 风格） */
function withLineNumbers(lines: string[], startLine: number): string {
  return lines
    .map((line, i) => `${String(startLine + i).padStart(5, " ")}\t${line}`)
    .join("\n");
}

export const readTool: ToolDefinition<ReadParams> = {
  name: "read",
  description: "读取一个文本文件的内容。返回带行号的内容，大文件会截断。",
  parameters: paramsSchema,
  readOnly: true,
  async execute(input, ctx): Promise<ToolResult> {
    const check = await checkPath(ctx.workspacePath, input.file_path);
    if (!check.ok) {
      return { status: "denied", output: check.reason ?? "路径不允许" };
    }

    let content: string;
    try {
      content = await getFsAdapter().readTextFile(check.resolved);
    } catch (err) {
      return { status: "error", output: `读取失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const allLines = content.split("\n");
    const start = input.offset ?? 1;
    const limit = input.limit ?? READ_DEFAULT_LIMIT;
    const startIdx = start - 1;
    const slice = allLines.slice(startIdx, startIdx + limit);

    const header = `${check.resolved}（${allLines.length} 行）`;
    const truncatedNote =
      startIdx + limit < allLines.length
        ? `\n…（共 ${allLines.length} 行，已显示第 ${start}–${startIdx + slice.length} 行）`
        : "";

    return {
      status: "success",
      output: `${header}\n${withLineNumbers(slice, start)}${truncatedNote}`,
    };
  },
};
