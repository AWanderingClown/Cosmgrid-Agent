// v0.7 阶段4 — read 工具（US-4.1：AI 读用户项目文件）
//
// 对齐 Claude Code 的 Read：{ file_path, offset?, limit? }，输出带行号，大文件截断。
//
// 2026-07-10 移植 OMO hashline：每行改为 `{行号}#{2位hash}|{内容}` 格式（取代纯行号）。
// hashline_edit 工具按这个 hash 引用定位编辑——文件在多轮对话之间被改动，hash 会立即
// 失配并报错，不会像老式行号/字符串定位那样悄悄改错地方。旧 edit 工具（old_string/new_string）
// 继续保留，两者并存。
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - 读失败 → errorResult{TOOL_NOT_FOUND, retryable=false}
// - 命中但内容为空（0 字节文件）→ warningResult 而不是 success——模型据此换源（不要重试）
// - 成功 → successResult + file artifact

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { getFsAdapter } from "./fs-adapter";
import { formatHashLine } from "./hashline";
import {
  readOrError,
  successResult,
  warningResult,
  TOOL_NOT_FOUND,
  type ToolArtifactRef,
  type ToolResultV2,
} from "./result-contract";

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
  async execute(input, ctx): Promise<ToolResultV2> {
    if (ctx.security?.kind !== "read-path") throw new Error("read 工具必须经 executeTool 调用（缺 ctx.security）");
    const resolved = ctx.security.resolved;

    const fs = getFsAdapter();
    const r = await readOrError(fs, resolved, {
      toolName: "read",
      pathLabel: resolved,
      notFoundStop: "确认文件存在 / 路径正确 / 有读权限；不是临时问题所以不该重试",
    });
    if (!r.ok) return r.result;
    const content = r.content;

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

    const output = `${header}\n${withLineNumbers(slice, start)}${truncatedNote}`;

    const artifacts: ToolArtifactRef[] = [
      { kind: "file", uri: resolved, label: `${allLines.length} 行（显示 ${start}–${startIdx + slice.length}）` },
    ];

    // 空文件 = "warning" 而不是 "success"，避免模型误以为读到了内容
    if (allLines.length === 1 && allLines[0] === "") {
      return warningResult({
        output: `${resolved}：空文件（0 字节）`,
        summary: `${resolved} 是空文件`,
        artifacts,
        error: {
          code: TOOL_NOT_FOUND,
          rootCauseHint: "文件存在但是空的（0 字节）",
          retryable: false,
          stopCondition: "不要重试 read 同一文件——换源：要么换文件、要么先 write 内容",
        },
        nextActions: [
          { action: "verify_with_glob", reason: "确认路径拼写是否正确（glob 找一下同名/近似路径）", safe: true },
          { action: "switch_file", reason: "可能读错了文件，切到目标文件再试", safe: true },
        ],
      });
    }

    return successResult({
      output,
      summary: `${resolved} ${allLines.length} 行`,
      artifacts,
      nextActions:
        startIdx + limit < allLines.length
          ? [
              {
                action: "read_more",
                reason: `文件还有 ${allLines.length - (startIdx + slice.length)} 行未读，用 offset=${startIdx + slice.length + 1} 继续`,
                safe: true,
              },
            ]
          : [],
    });
  },
};