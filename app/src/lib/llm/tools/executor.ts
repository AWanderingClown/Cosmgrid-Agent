// v0.7 阶段4 — 工具执行器
//
// 统一入口：zod 校验参数 → 执行 → 截断输出 → 落 ToolExecution 审计。
// 任何工具的异常都被收敛成 status=error 的结果（不抛给上层，避免一个工具崩了整条对话挂）。

import { toolExecutions } from "../../db";
import type { AnyToolDefinition, ToolContext, ToolResult } from "./types";

/** 审计里 output 的截断上限（防超长内容撑爆库） */
export const MAX_OUTPUT_CHARS = 10_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n…(truncated)" : s;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 执行一个工具并落审计。
 * - 参数校验失败 → status=error，不执行
 * - 执行抛错 → status=error
 * - 始终写一条 ToolExecution（审计失败只记日志，不影响返回）
 */
export async function executeTool(
  tool: AnyToolDefinition,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const startedAt = Date.now();
  let result: ToolResult;

  try {
    const parsed = tool.parameters.parse(rawInput);
    result = await tool.execute(parsed, ctx);
  } catch (err) {
    result = { status: "error", output: `工具 ${tool.name} 执行失败：${errMessage(err)}` };
  }

  const durationMs = Date.now() - startedAt;
  try {
    await toolExecutions.create({
      projectId: ctx.projectId ?? null,
      conversationId: ctx.conversationId ?? null,
      toolName: tool.name,
      input: JSON.stringify(rawInput),
      output: truncate(result.output),
      status: result.status,
      userConfirmed: result.status !== "denied" && !tool.readOnly,
      reversible: result.reversible ?? false,
      durationMs,
    });
  } catch (auditErr) {
    console.error("[tools] 写 ToolExecution 审计失败:", auditErr);
  }

  return result;
}
