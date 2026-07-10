// LSP 工具集合：diagnostics / definition / hover（v0.7 阶段4 + 2026-07-11 阶段2）
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - lsp_diagnostics 有报错 → errorResult{TOOL_DIAGNOSTIC, retryable=false}——
//   LSP 报错本质是"代码有问题"而非"工具失败"，不该让模型重试工具调用，应该修代码。
// - lsp_diagnostics 干净 → successResult
// - LSP 查询抛错 → errorResult{TOOL_UNKNOWN_ERROR, retryable=false}

import { z } from "zod";
import type { ToolDefinition, ToolContext } from "./types";
import { getLspDefinition, getLspDiagnostics, getLspHover } from "@/lib/lsp/lsp-session";
import {
  errorResult,
  successResult,
  TOOL_DIAGNOSTIC,
  TOOL_UNKNOWN_ERROR,
  type ToolResultV2,
} from "./result-contract";

const fileSchema = z.object({
  file_path: z.string().describe("要检查的源码文件路径（相对工作区或绝对路径）"),
});

const positionSchema = fileSchema.extend({
  line: z.number().int().min(1).describe("1-based 行号"),
  character: z.number().int().min(1).describe("1-based 列号"),
});

type FileParams = z.infer<typeof fileSchema>;
type PositionParams = z.infer<typeof positionSchema>;

async function withCheckedFile(
  ctx: ToolContext,
  run: (resolved: string) => Promise<string>,
): Promise<ToolResultV2> {
  if (ctx.security?.kind !== "read-path" || !ctx.security.resolved) {
    throw new Error("lsp 工具必须经 executeTool 调用（缺 ctx.security）");
  }
  try {
    const resolved = ctx.security.resolved;
    const output = await run(resolved);
    return successResult({
      output,
      summary: "LSP 查询完成",
      artifacts: [{ kind: "file", uri: resolved, label: "LSP 查询目标文件" }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult({
      output: `LSP 查询失败：${msg}`,
      summary: "LSP 抛错",
      error: {
        code: TOOL_UNKNOWN_ERROR,
        rootCauseHint: msg,
        retryable: false,
        stopCondition: "LSP 进程可能没启动或没装对应 language server；不是重试能解决的",
      },
    });
  }
}

export const lspDiagnosticsTool: ToolDefinition<FileParams> = {
  name: "lsp_diagnostics",
  description: "通过语言服务读取一个源码文件的诊断信息，比如 TypeScript 类型错误。",
  parameters: fileSchema,
  readOnly: true,
  security: { kind: "read-path", pathField: "file_path" },
  execute: async (_input, ctx) => {
    if (ctx.security?.kind !== "read-path" || !ctx.security.resolved) {
      throw new Error("lsp 工具必须经 executeTool 调用（缺 ctx.security）");
    }
    const resolved = ctx.security.resolved;
    try {
      const output = await getLspDiagnostics(ctx.workspacePath, resolved);
      // 阶段2：diagnostics 是"代码有问题"的语义，不能当成 success（否则模型会以为改对了）。
      // 通过简单判断：output 里有 "error" / "Error" 之类的报错关键字 → status=warning
      // 让模型知道"工具有结果，但结果是不好的"。不强制解析 LSP 协议（不同语言 server 格式不同），
      // 走宽匹配：LSP 没报错时输出通常是 "(no diagnostics)" 或为空。
      const looksClean =
        output.trim() === "" ||
        /no diagnostics|no errors|no issues/i.test(output) ||
        /^\s*$/m.test(output);
      if (!looksClean) {
        return errorResult({
          output,
          summary: `LSP 报告问题 ${resolved}`,
          error: {
            code: TOOL_DIAGNOSTIC,
            rootCauseHint: "LSP 报告了类型/语法问题",
            retryable: false,
            stopCondition:
              "不要重试 lsp_diagnostics——修代码本身（按错误信息改对应行），改完再跑一次验证",
          },
          artifacts: [{ kind: "diagnostic", uri: resolved, label: "LSP 诊断结果" }],
          nextActions: [
            { action: "fix_code_per_diagnostics", reason: "按上面 LSP 报错修对应行/类型", safe: true },
            { action: "re_read_after_fix", reason: "改完代码后重新 read 一遍确认", safe: true },
          ],
        });
      }
      return successResult({
        output,
        summary: `${resolved} 无 LSP 错误`,
        artifacts: [{ kind: "diagnostic", uri: resolved, label: "LSP 诊断结果（干净）" }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult({
        output: `LSP 查询失败：${msg}`,
        summary: "lsp_diagnostics 抛错",
        error: {
          code: TOOL_UNKNOWN_ERROR,
          rootCauseHint: msg,
          retryable: false,
        },
      });
    }
  },
};

export const lspDefinitionTool: ToolDefinition<PositionParams> = {
  name: "lsp_definition",
  description: "通过语言服务查询指定源码位置的定义位置。line/character 都是 1-based。",
  parameters: positionSchema,
  readOnly: true,
  security: { kind: "read-path", pathField: "file_path" },
  execute: (input, ctx) =>
    withCheckedFile(ctx, (resolved) =>
      getLspDefinition(ctx.workspacePath, resolved, input.line, input.character),
    ),
};

export const lspHoverTool: ToolDefinition<PositionParams> = {
  name: "lsp_hover",
  description: "通过语言服务查询指定源码位置的类型/文档悬停信息。line/character 都是 1-based。",
  parameters: positionSchema,
  readOnly: true,
  security: { kind: "read-path", pathField: "file_path" },
  execute: (input, ctx) =>
    withCheckedFile(ctx, (resolved) =>
      getLspHover(ctx.workspacePath, resolved, input.line, input.character),
    ),
};