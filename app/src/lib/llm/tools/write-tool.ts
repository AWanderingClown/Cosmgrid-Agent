// v0.7 阶段4b — write 工具（US-4.4 配套：新建/覆盖文件，必须用户确认）
//
// 安全红线：
//   1. 路径必须过 path-safety（工作区边界 + 敏感路径）
//   2. 必须有 ctx.confirm 回调且用户点了确认，否则 denied（绝不静默写盘）
//   3. 覆盖已有文件时，diff 展示给用户看清改了什么

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { checkPath } from "./path-safety";
import { getFsAdapter } from "./fs-adapter";
import { computeDiff, diffSummaryLine } from "./diff-util";
import { requireApproval } from "./confirm";

const paramsSchema = z.object({
  file_path: z.string().describe("要写入的文件路径（相对工作区或绝对路径）"),
  content: z.string().describe("文件的完整新内容"),
});

type WriteParams = z.infer<typeof paramsSchema>;

/** 取父目录（用于写前 mkdirp） */
function parentDir(absPath: string): string {
  const idx = absPath.lastIndexOf("/");
  return idx <= 0 ? "/" : absPath.slice(0, idx);
}

export const writeTool: ToolDefinition<WriteParams> = {
  name: "write",
  description: "新建或覆盖一个文件（写入完整内容）。会先让用户确认改动，确认后才写盘。",
  parameters: paramsSchema,
  readOnly: false,
  async execute(input, ctx): Promise<ToolResult> {
    const check = checkPath(ctx.workspacePath, input.file_path);
    if (!check.ok) return { status: "denied", output: check.reason ?? "路径不允许" };

    const fs = getFsAdapter();
    const existed = await fs.exists(check.resolved);
    const oldContent = existed ? await fs.readTextFile(check.resolved).catch(() => "") : "";
    const diff = computeDiff(oldContent, input.content);

    const denied = await requireApproval(ctx, {
      toolName: "write",
      summary: `${existed ? "覆盖" : "新建"} ${diffSummaryLine(check.resolved, diff)}`,
      diff: diff.patch,
    });
    if (denied) return denied;

    try {
      await fs.mkdirp(parentDir(check.resolved));
      await fs.writeTextFile(check.resolved, input.content);
    } catch (err) {
      return { status: "error", output: `写入失败：${err instanceof Error ? err.message : String(err)}` };
    }

    return {
      status: "success",
      output: `已写入 ${check.resolved}（+${diff.added} −${diff.removed}）`,
      reversible: false,
    };
  },
};
