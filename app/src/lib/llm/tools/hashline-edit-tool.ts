// 2026-07-10 新增 — hashline_edit 工具（移植自 oh-my-openagent 的 hashline-core 编辑语义）
//
// 跟老 edit 工具（old_string/new_string 唯一匹配）互补：hashline_edit 按 read 工具输出的
// 「行号#hash」引用定位，apply 前会校验每个引用的 hash 是否跟当前文件内容一致——文件在
// 多轮对话之间被改过，hash 立即失配并把「当前真实 hash」回显给模型，而不是悄悄改错行、
// 或者靠"唯一子串匹配"在内容重复时直接卡死。安全网（path-safety / confirm / 工作区外
// 多问一句 / git 快照）与老 edit 工具完全一致，全部经由 executor 的 write-path 声明统一跑。

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { getFsAdapter } from "./fs-adapter";
import { computeDiff, diffSummaryLine } from "./diff-util";
import { requireApproval } from "./confirm";
import { withDiagnostics } from "./diagnostics";
import { applyHashlineEditsWithReport, normalizeHashlineEdits, HashlineMismatchError } from "./hashline";

const editItemSchema = z.object({
  op: z.enum(["replace", "append", "prepend"]).describe("replace=替换定位到的行；append=在该行之后插入；prepend=在该行之前插入"),
  pos: z.string().optional().describe('锚点引用，格式 "行号#hash"（原样取自 read 工具输出，如 "12#ZP"）'),
  end: z.string().optional().describe("仅 replace 用：范围结束引用，与 pos 一起框定连续多行替换区间"),
  lines: z.union([z.string(), z.array(z.string())]).describe("新内容：单行传字符串，多行传字符串数组"),
});

const paramsSchema = z.object({
  file_path: z.string().describe("要修改的文件路径"),
  edits: z.array(editItemSchema).min(1).describe("一组按 hashline 引用定位的编辑操作，按文件从下到上顺序应用"),
});

type HashlineEditParams = z.infer<typeof paramsSchema>;

export const hashlineEditTool: ToolDefinition<HashlineEditParams> = {
  name: "hashline_edit",
  description:
    "编辑文件的首选工具。按 read 工具输出的「行号#hash」引用精确编辑文件。文件自上次 read 后若被改动，" +
    "引用会失配并报错（错误信息里带最新的正确引用，照着重试即可）。支持 replace（替换单行或 pos~end 范围）/" +
    "append（该行后插入）/ prepend（该行前插入）。能处理 old_string 在文件里重复出现的情况——普通 edit 工具做不到。" +
    "会先让用户确认。",
  parameters: paramsSchema,
  readOnly: false,
  security: { kind: "write-path", pathField: "file_path" },
  async execute(input, ctx): Promise<ToolResult> {
    if (ctx.security?.kind !== "write-path") throw new Error("hashline_edit 工具必须经 executeTool 调用（缺 ctx.security）");
    const { resolved, external } = ctx.security;

    const fs = getFsAdapter();
    let oldContent: string;
    try {
      oldContent = await fs.readTextFile(resolved);
    } catch (err) {
      return { status: "error", output: `读取失败：${err instanceof Error ? err.message : String(err)}` };
    }

    let report;
    try {
      const normalized = normalizeHashlineEdits(input.edits);
      report = applyHashlineEditsWithReport(oldContent, normalized);
    } catch (err) {
      if (err instanceof HashlineMismatchError) {
        return { status: "error", output: err.message };
      }
      return { status: "error", output: `编辑校验失败：${err instanceof Error ? err.message : String(err)}` };
    }

    if (report.content === oldContent) {
      return { status: "error", output: "所有编辑都是空操作（内容与原文一致），未修改。" };
    }

    const diff = computeDiff(oldContent, report.content);
    const externalNotice = external ? "⚠️ 这次要写到工作区之外：" : "";
    const denied = await requireApproval(ctx, {
      toolName: "hashline_edit",
      summary: `${externalNotice}修改 ${diffSummaryLine(resolved, diff)}`,
      diff: diff.patch,
    });
    if (denied) return denied;

    try {
      await fs.writeTextFile(resolved, report.content);
    } catch (err) {
      return { status: "error", output: `写入失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const dedupeNote = report.deduplicatedEdits > 0 ? `（已去重 ${report.deduplicatedEdits} 处重复编辑）` : "";
    const baseOutput = `已修改 ${resolved}（+${diff.added} −${diff.removed}）${dedupeNote}`;
    return {
      status: "success",
      output: await withDiagnostics(ctx.workspacePath, resolved, baseOutput),
    };
  },
};
