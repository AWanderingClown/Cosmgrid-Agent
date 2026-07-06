// v0.7 阶段4b — edit 工具（US-4.4：改文件某处，old_string→new_string，必须用户确认）
//
// 比 write 更精准、更安全：只替换指定片段，diff 范围小。
// 安全红线同 write：path-safety + 必须确认 + 唯一匹配（防止误改多处）。

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { checkWritePath } from "./path-safety";
import { getFsAdapter } from "./fs-adapter";
import { computeDiff, diffSummaryLine } from "./diff-util";
import { requireApproval } from "./confirm";
import { snapshotWrite } from "./git-snapshot";
import { withDiagnostics } from "./diagnostics";

const paramsSchema = z.object({
  file_path: z.string().describe("要修改的文件路径"),
  old_string: z.string().describe("要被替换的原文片段（必须在文件中唯一出现）"),
  new_string: z.string().describe("替换成的新片段"),
});

type EditParams = z.infer<typeof paramsSchema>;

/** 统计子串出现次数 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export const editTool: ToolDefinition<EditParams> = {
  name: "edit",
  description: "把文件里某段文本（old_string）替换成新文本（new_string）。old_string 必须唯一。会先让用户确认。",
  parameters: paramsSchema,
  readOnly: false,
  async execute(input, ctx): Promise<ToolResult> {
    const check = await checkWritePath(ctx.workspacePath, input.file_path);
    if (!check.ok) return { status: "denied", output: check.reason ?? "路径不允许" };
    if (input.old_string === input.new_string) {
      return { status: "error", output: "old_string 与 new_string 相同，无需修改。" };
    }

    const fs = getFsAdapter();
    let oldContent: string;
    try {
      oldContent = await fs.readTextFile(check.resolved);
    } catch (err) {
      return { status: "error", output: `读取失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const occurrences = countOccurrences(oldContent, input.old_string);
    if (occurrences === 0) {
      return { status: "error", output: "在文件中找不到 old_string，未修改。" };
    }
    if (occurrences > 1) {
      return { status: "error", output: `old_string 在文件中出现 ${occurrences} 次（需唯一），未修改。请提供更多上下文。` };
    }

    const newContent = oldContent.replace(input.old_string, input.new_string);
    const diff = computeDiff(oldContent, newContent);

    const externalNotice = check.external ? "⚠️ 这次要写到工作区之外：" : "";
    const denied = await requireApproval(ctx, {
      toolName: "edit",
      summary: `${externalNotice}修改 ${diffSummaryLine(check.resolved, diff)}`,
      diff: diff.patch,
    });
    if (denied) return denied;

    try {
      await fs.writeTextFile(check.resolved, newContent);
    } catch (err) {
      return { status: "error", output: `写入失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const reversible = await snapshotWrite(ctx.workspacePath, check.resolved, "edit");
    const baseOutput = `已修改 ${check.resolved}（+${diff.added} −${diff.removed}）${reversible ? "，已 git 快照可回滚" : ""}`;
    return {
      status: "success",
      output: await withDiagnostics(ctx.workspacePath, check.resolved, baseOutput),
      reversible,
    };
  },
};
