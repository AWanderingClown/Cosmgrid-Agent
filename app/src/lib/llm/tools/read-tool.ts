// v0.7 阶段4 — read 工具（US-4.1：AI 读用户项目文件）
//
// 对齐 Claude Code 的 Read：{ file_path, offset?, limit? }，输出带行号，大文件截断。
//
// 2026-07-10 移植 OMO hashline：每行改为 `{行号}#{2位hash}|{内容}` 格式（取代纯行号）。
// hashline_edit 工具按这个 hash 引用定位编辑——文件在多轮对话之间被改动，hash 会立即
// 失配并报错，不会像老式行号/字符串定位那样悄悄改错地方。旧 edit 工具（old_string/new_string）
// 继续保留，两者并存。

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { getFsAdapter } from "./fs-adapter";
import { formatHashLine } from "./hashline";

/** 默认最多读 200 行（大文件截断，避免撑爆上下文） */
const READ_DEFAULT_LIMIT = 200;

const paramsSchema = z.object({
  file_path: z.string().describe("要读取的文件路径（相对工作区或绝对路径）"),
  offset: z.number().int().min(1).optional().describe("起始行号（1-based）"),
  limit: z.number().int().min(1).optional().describe("最多读取的行数"),
});

type ReadParams = z.infer<typeof paramsSchema>;

/** 给每行加 hashline 前缀：`{行号}#{hash}|{内容}`，供 hashline_edit 按引用定位。 */
function withLineNumbers(lines: string[], startLine: number): string {
  return lines.map((line, i) => formatHashLine(startLine + i, line)).join("\n");
}

export const readTool: ToolDefinition<ReadParams> = {
  name: "read",
  description:
    "读取一个文本文件的内容。每行格式为「行号#hash|内容」，大文件会截断。" +
    "用 hashline_edit 工具改动时必须原样带上「行号#hash」引用——文件若被改过，hash 会立即失配并提示新引用。",
  parameters: paramsSchema,
  readOnly: true,
  security: { kind: "read-path", pathField: "file_path" },
  async execute(input, ctx): Promise<ToolResult> {
    if (ctx.security?.kind !== "read-path") throw new Error("read 工具必须经 executeTool 调用（缺 ctx.security）");
    const resolved = ctx.security.resolved;

    let content: string;
    try {
      content = await getFsAdapter().readTextFile(resolved);
    } catch (err) {
      return { status: "error", output: `读取失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const allLines = content.split("\n");
    const start = input.offset ?? 1;
    const limit = input.limit ?? READ_DEFAULT_LIMIT;
    const startIdx = start - 1;
    const slice = allLines.slice(startIdx, startIdx + limit);

    const header = `${resolved}（${allLines.length} 行）`;
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
