// v0.7 阶段4b — write 工具（US-4.4 配套：新建/覆盖文件，必须用户确认）
//
// 安全红线：
//   1. 路径必须过 path-safety（工作区边界 + 敏感路径）
//   2. 必须有 ctx.confirm 回调且用户点了确认，否则 denied（绝不静默写盘）
//   3. 覆盖已有文件时，diff 展示给用户看清改了什么
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2，把工具产物 / 错误码 / 下一步建议
// 暴露给模型。成功带 file + diff artifact + nextActions（"建议用 read 校验一遍"）；
// 拒绝走 deniedResult；写入失败走 errorResult{TOOL_UNKNOWN_ERROR, retryable=false}。

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { getFsAdapter } from "./fs-adapter";
import { computeDiff, diffSummaryLine } from "./diff-util";
import { requireApprovalAsV2 } from "./confirm";
import { withDiagnostics } from "./diagnostics";
import {
  errorResult,
  successResult,
  TOOL_UNKNOWN_ERROR,
  type ToolArtifactRef,
  type ToolResultV2,
} from "./result-contract";

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
  async execute(input, ctx): Promise<ToolResultV2> {
    if (ctx.security?.kind !== "write-path") throw new Error("write 工具必须经 executeTool 调用（缺 ctx.security）");
    const { resolved, external } = ctx.security;

    const fs = getFsAdapter();
    const existed = await fs.exists(resolved);
    const oldContent = existed ? await fs.readTextFile(resolved).catch(() => "") : "";
    const diff = computeDiff(oldContent, input.content);

    const externalNotice = external ? "⚠️ 这次要写到工作区之外：" : "";
    const denied = await requireApprovalAsV2(
      ctx,
      {
        toolName: "write",
        summary: `${externalNotice}${existed ? "覆盖" : "新建"} ${diffSummaryLine(resolved, diff)}`,
        diff: diff.patch,
      },
      "用户拒绝写权限",
    );
    if (denied) return denied;

    try {
      await fs.mkdirp(parentDir(resolved));
      await fs.writeTextFile(resolved, input.content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult({
        output: `写入失败：${msg}`,
        summary: `write 失败 ${resolved}`,
        error: {
          code: TOOL_UNKNOWN_ERROR,
          rootCauseHint: msg,
          retryable: false,
          stopCondition: "检查目标路径是否合法、磁盘是否满、父目录权限是否足够",
        },
      });
    }

    // git 快照 + reversible 标记现在由 executor 在 execute() 成功返回后统一做
    // （L6 安全网收拢，2026-07-09）：executor 拿到本次 resolved 路径就能做，工具自己不用管。
    const baseOutput = `已写入 ${resolved}（+${diff.added} −${diff.removed}）`;
    const outputWithDiag = await withDiagnostics(ctx.workspacePath, resolved, baseOutput);

    const artifacts: ToolArtifactRef[] = [
      {
        kind: "file",
        uri: resolved,
        label: `${existed ? "覆盖" : "新建"} +${diff.added} −${diff.removed}`,
        external: external,
      },
    ];
    if (diff.patch) {
      artifacts.push({ kind: "diff", uri: resolved, label: "本次写入的 diff 片段" });
    }

    return successResult({
      output: outputWithDiag,
      summary: `${existed ? "覆盖" : "新建"} ${resolved} (+${diff.added} −${diff.removed})`,
      artifacts,
      nextActions: [
        {
          action: "read_back",
          reason: "建议用 read 工具校验一遍写入是否符合预期，特别是大文件 / 多处替换",
          safe: true,
        },
      ],
      reversible: true, // executor 拿到 resolved 会调 git snapshot，可能升级成 true；这里先标 true 让 UI 显示
    });
  },
};