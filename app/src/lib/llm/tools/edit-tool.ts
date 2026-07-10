// v0.7 阶段4b — edit 工具（US-4.4：改文件某处，old_string→new_string，必须用户确认）
//
// 比 write 更精准、更安全：只替换指定片段，diff 范围小。
// 安全红线同 write：path-safety + 必须确认 + 唯一匹配（防止误改多处）。
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - old_string 不唯一 → errorResult{TOOL_OLD_STRING_AMBIGUOUS, retryable=true,
//   retryInstruction="请补更多上下文确保唯一"}——这是阶段2 工作项"old_string 不唯一
//   返回可重试错误和补上下文建议"的明确要求。
// - old_string 缺失 → errorResult{TOOL_OLD_STRING_MISSING, retryable=true,
//   retryInstruction="先 read 一次拿到当前内容再改"}，避免模型在错误文件状态上
//   反复试错。
// - 用户拒绝 / 安全拦截 → deniedResult。
// - 成功 → successResult + file artifact + diff artifact。

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { getFsAdapter } from "./fs-adapter";
import { computeDiff, diffSummaryLine } from "./diff-util";
import { requireApprovalAsV2 } from "./confirm";
import { withDiagnostics } from "./diagnostics";
import {
  errorResult,
  readOrError,
  successResult,
  TOOL_OLD_STRING_AMBIGUOUS,
  TOOL_OLD_STRING_MISSING,
  TOOL_UNKNOWN_ERROR,
  type ToolArtifactRef,
  type ToolResultV2,
} from "./result-contract";

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
  description:
    "把文件里某段文本（old_string）替换成新文本（new_string）。old_string 必须唯一。会先让用户确认。" +
    "优先用 hashline_edit（按行号#hash 引用，能处理文本重复出现、能感知文件是否被改过）；" +
    "只有确定 old_string 在文件里唯一出现、且是简单一次性替换时才用这个工具。",
  parameters: paramsSchema,
  readOnly: false,
  security: { kind: "write-path", pathField: "file_path" },
  async execute(input, ctx): Promise<ToolResultV2> {
    if (ctx.security?.kind !== "write-path") throw new Error("edit 工具必须经 executeTool 调用（缺 ctx.security）");
    const { resolved, external } = ctx.security;
    if (input.old_string === input.new_string) {
      return errorResult({
        output: "old_string 与 new_string 相同，无需修改。",
        summary: "edit 跳过（old==new）",
        error: {
          code: TOOL_UNKNOWN_ERROR,
          rootCauseHint: "old_string 和 new_string 完全一致，没有任何要改的内容",
          retryable: false,
          stopCondition: "要么直接放弃这次 edit，要么重新设计要替换的内容",
        },
      });
    }

    const fs = getFsAdapter();
    const r = await readOrError(fs, resolved, {
      toolName: "edit",
      pathLabel: resolved,
      notFoundStop: "确认文件存在并且有读权限",
    });
    if (!r.ok) return r.result;
    const oldContent = r.content;

    const occurrences = countOccurrences(oldContent, input.old_string);
    if (occurrences === 0) {
      return errorResult({
        output: "在文件中找不到 old_string，未修改。",
        summary: "edit 找不到 old_string",
        error: {
          code: TOOL_OLD_STRING_MISSING,
          rootCauseHint: "文件里完全没有这一段——可能文件被改过、路径错了、或 old_string 里有不可见字符",
          retryable: true,
          retryInstruction:
            "先 read 这个文件拿最新内容，再基于现状重新构造 old_string（带更多上下文）",
        },
        nextActions: [
          {
            action: "read_then_retry",
            reason: "文件可能已被外部修改，old_string 失效，先 read 拿最新状态",
            safe: true,
          },
          {
            action: "switch_to_hashline_edit",
            reason: "hashline_edit 工具按行号 + 哈希定位，不依赖文本唯一性，更适合此场景",
            safe: true,
          },
        ],
      });
    }
    if (occurrences > 1) {
      return errorResult({
        output: `old_string 在文件中出现 ${occurrences} 次（需唯一），未修改。请提供更多上下文。`,
        summary: `edit 命中 ${occurrences} 处`,
        error: {
          code: TOOL_OLD_STRING_AMBIGUOUS,
          rootCauseHint: `old_string 在文件里出现 ${occurrences} 次，无法确定要改哪一处`,
          retryable: true,
          retryInstruction:
            "把 old_string 扩成包含更多上下文（前后几行 / 函数签名 / 注释），确保唯一出现一次后再调用",
        },
        nextActions: [
          {
            action: "add_more_context",
            reason: "old_string 需要更长的上下文才能唯一",
            safe: true,
          },
          {
            action: "switch_to_hashline_edit",
            reason: "hashline_edit 用行号 + 哈希锚定，不依赖字符串唯一性",
            safe: true,
          },
        ],
      });
    }

    const newContent = oldContent.replace(input.old_string, input.new_string);
    const diff = computeDiff(oldContent, newContent);

    const externalNotice = external ? "⚠️ 这次要写到工作区之外：" : "";
    const denied = await requireApprovalAsV2(
      ctx,
      {
        toolName: "edit",
        summary: `${externalNotice}修改 ${diffSummaryLine(resolved, diff)}`,
        diff: diff.patch,
      },
      "用户拒绝 edit",
    );
    if (denied) return denied;

    try {
      await fs.writeTextFile(resolved, newContent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult({
        output: `写入失败：${msg}`,
        summary: `edit 写入失败 ${resolved}`,
        error: {
          code: TOOL_UNKNOWN_ERROR,
          rootCauseHint: msg,
          retryable: false,
          stopCondition: "检查文件权限 / 磁盘空间",
        },
      });
    }

    // git 快照 + reversible 标记现在由 executor 在 execute() 成功返回后统一做（同 write-tool）。
    const baseOutput = `已修改 ${resolved}（+${diff.added} −${diff.removed}）`;
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
      summary: `修改 ${resolved} (+${diff.added} −${diff.removed})`,
      artifacts,
      nextActions: [
        {
          action: "verify_with_lsp",
          reason: "代码改动后建议跑一次 lsp_diagnostics 看新代码是否引入类型错误",
          safe: true,
        },
      ],
      reversible: true,
    });
  },
};