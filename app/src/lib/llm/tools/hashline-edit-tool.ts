// 2026-07-10 新增 — hashline_edit 工具（移植自 oh-my-openagent 的 hashline-core 编辑语义）
//
// 跟老 edit 工具（old_string/new_string 唯一匹配）互补：hashline_edit 按 read 工具输出的
// 「行号#hash」引用定位，apply 前会校验每个引用的 hash 是否跟当前文件内容一致——文件在
// 多轮对话之间被改过，hash 立即失配并把「当前真实 hash」回显给模型，而不是悄悄改错行、
// 或者靠"唯一子串匹配"在内容重复时直接卡死。安全网（path-safety / confirm / 工作区外
// 多问一句 / git 快照）与老 edit 工具完全一致，全部经由 executor 的 write-path 声明统一跑。
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - HashlineMismatchError → errorResult{TOOL_OLD_STRING_MISSING（hash 不匹配本质上是
//   "anchor not found in current content"）, retryable=true, retryInstruction="照错误信息
//   里给的最新 hash 重新构造引用"}——hashline 协议本身就擅长处理这种情况。
// - 编辑校验抛错 → errorResult{TOOL_INVALID_PARAMS, retryable=true, retryInstruction}
// - 用户拒绝 → deniedResult。
// - 成功 → successResult + file + diff artifacts。

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { getFsAdapter } from "./fs-adapter";
import { computeDiff, diffSummaryLine } from "./diff-util";
import { requireApprovalAsV2 } from "./confirm";
import { withDiagnostics } from "./diagnostics";
import { applyHashlineEditsWithReport, normalizeHashlineEdits, HashlineMismatchError } from "./hashline";
import {
  errorResult,
  readOrError,
  successResult,
  TOOL_INVALID_PARAMS,
  TOOL_OLD_STRING_MISSING,
  TOOL_UNKNOWN_ERROR,
  type ToolArtifactRef,
  type ToolResultV2,
} from "./result-contract";

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
    "append（该行后插入）/ prepend（该行之前插入）。能处理 old_string 在文件里重复出现的情况——普通 edit 工具做不到。" +
    "会先让用户确认。",
  parameters: paramsSchema,
  readOnly: false,
  security: { kind: "write-path", pathField: "file_path" },
  async execute(input, ctx): Promise<ToolResultV2> {
    if (ctx.security?.kind !== "write-path") throw new Error("hashline_edit 工具必须经 executeTool 调用（缺 ctx.security）");
    const { resolved, external } = ctx.security;

    const fs = getFsAdapter();
    const r = await readOrError(fs, resolved, {
      toolName: "hashline_edit",
      pathLabel: resolved,
      notFoundStop: "确认文件存在且有读权限",
    });
    if (!r.ok) return r.result;
    const oldContent = r.content;

    let report;
    try {
      const normalized = normalizeHashlineEdits(input.edits);
      report = applyHashlineEditsWithReport(oldContent, normalized);
    } catch (err) {
      if (err instanceof HashlineMismatchError) {
        // hash 失配：阶段2 工作项要求 old_string 不唯一 / 找不到时返回"可重试错误和补上下文建议"。
        // hashline 场景下"补上下文"对应的就是按错误里给的最新 hash 重试——错误信息本身已经是可
        // 执行的修复提示（带着正确 hash），不需要模型再 read 一次。
        return errorResult({
          output: err.message,
          summary: "hashline_edit 引用失配",
          error: {
            code: TOOL_OLD_STRING_MISSING,
            rootCauseHint:
              "引用的行号#hash 跟当前文件实际内容不一致（文件可能已被外部改动 / 你用了上一次的 read 结果）",
            retryable: true,
            retryInstruction:
              "错误信息里通常已经列出每个失配引用对应的最新 hash，照着把 edits.pos / edits.end 改成最新值后重试",
          },
          nextActions: [
            {
              action: "use_suggested_hash",
              reason: "错误信息里通常已经给出每个失配引用对应的最新 hash，直接采用",
              safe: true,
            },
            {
              action: "read_again_first",
              reason: "如果错误信息没列出最新 hash（罕见），先 read 拿最新行号+hash 再改",
              safe: true,
            },
          ],
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult({
        output: `编辑校验失败：${msg}`,
        summary: "hashline_edit 校验失败",
        error: {
          code: TOOL_INVALID_PARAMS,
          rootCauseHint: msg,
          retryable: true,
          retryInstruction: "检查 edits 数组里 op/pos/end/lines 是否符合规范（pos 必为「行号#hash」）",
        },
      });
    }

    if (report.content === oldContent) {
      return errorResult({
        output: "所有编辑都是空操作（内容与原文一致），未修改。",
        summary: "hashline_edit 空操作",
        error: {
          code: TOOL_UNKNOWN_ERROR,
          rootCauseHint: "edits 全部命中但替换内容与原文相同，没有真实改动",
          retryable: false,
          stopCondition: "重新设计要替换的内容，确保至少一行真的有差异",
        },
      });
    }

    const diff = computeDiff(oldContent, report.content);
    const externalNotice = external ? "⚠️ 这次要写到工作区之外：" : "";
    const denied = await requireApprovalAsV2(
      ctx,
      {
        toolName: "hashline_edit",
        summary: `${externalNotice}修改 ${diffSummaryLine(resolved, diff)}`,
        diff: diff.patch,
      },
      "用户拒绝 hashline_edit",
    );
    if (denied) return denied;

    try {
      await fs.writeTextFile(resolved, report.content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult({
        output: `写入失败：${msg}`,
        summary: `hashline_edit 写入失败 ${resolved}`,
        error: {
          code: TOOL_UNKNOWN_ERROR,
          rootCauseHint: msg,
          retryable: false,
          stopCondition: "检查文件权限 / 磁盘空间",
        },
      });
    }

    const dedupeNote = report.deduplicatedEdits > 0 ? `（已去重 ${report.deduplicatedEdits} 处重复编辑）` : "";
    const baseOutput = `已修改 ${resolved}（+${diff.added} −${diff.removed}）${dedupeNote}`;
    const outputWithDiag = await withDiagnostics(ctx.workspacePath, resolved, baseOutput);

    const artifacts: ToolArtifactRef[] = [
      {
        kind: "file",
        uri: resolved,
        label: `修改 +${diff.added} −${diff.removed}`,
        external: external,
      },
      { kind: "diff", uri: resolved, label: "本次修改的 diff 片段" },
    ];

    return successResult({
      output: outputWithDiag,
      summary: `修改 ${resolved} (+${diff.added} −${diff.removed})${dedupeNote}`,
      artifacts,
      nextActions: [
        {
          action: "verify_with_lsp",
          reason: "代码改动后建议跑 lsp_diagnostics 看新代码是否引入类型错误",
          safe: true,
        },
      ],
      reversible: true,
    });
  },
};