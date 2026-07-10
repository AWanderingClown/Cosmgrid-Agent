// v0.7 阶段4b — write 工具（US-4.4 配套：新建/覆盖文件，必须用户确认）
//
// 安全红线：
//   1. 路径必须过 path-safety（工作区边界 + 敏感路径）
//   2. 必须有 ctx.confirm 回调且用户点了确认，否则 denied（绝不静默写盘）
//   3. 覆盖已有文件时，diff 展示给用户看清改了什么

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { getFsAdapter } from "./fs-adapter";
import { computeDiff, diffSummaryLine } from "./diff-util";
import { requireApproval } from "./confirm";
import { withDiagnostics } from "./diagnostics";

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
  security: { kind: "write-path", pathField: "file_path" },
  async execute(input, ctx): Promise<ToolResult> {
    if (ctx.security?.kind !== "write-path") throw new Error("write 工具必须经 executeTool 调用（缺 ctx.security）");
    const { resolved, external } = ctx.security;

    const fs = getFsAdapter();
    const existed = await fs.exists(resolved);
    const oldContent = existed ? await fs.readTextFile(resolved).catch(() => "") : "";
    const diff = computeDiff(oldContent, input.content);

    const externalNotice = external ? "⚠️ 这次要写到工作区之外：" : "";
    const denied = await requireApproval(ctx, {
      toolName: "write",
      summary: `${externalNotice}${existed ? "覆盖" : "新建"} ${diffSummaryLine(resolved, diff)}`,
      diff: diff.patch,
    });
    if (denied) return denied;

    try {
      await fs.mkdirp(parentDir(resolved));
      await fs.writeTextFile(resolved, input.content);
    } catch (err) {
      return { status: "error", output: `写入失败：${err instanceof Error ? err.message : String(err)}` };
    }

    // git 快照 + reversible 标记现在由 executor 在 execute() 成功返回后统一做
    // （L6 安全网收拢，2026-07-09）：executor 拿到本次 resolved 路径就能做，工具自己不用管。
    const baseOutput = `已写入 ${resolved}（+${diff.added} −${diff.removed}）`;
    return {
      status: "success",
      output: await withDiagnostics(ctx.workspacePath, resolved, baseOutput),
    };
  },
};
