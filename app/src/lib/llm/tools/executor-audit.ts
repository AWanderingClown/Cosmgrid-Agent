import { toolExecutions } from "../../db";
import {
  clipAndRedact,
  serializeResultV2,
  type ToolResultV2,
} from "./result-contract";
import { safeStringify } from "./executor-serialization";
import type { AnyToolDefinition, ToolContext } from "./types";

export async function persistToolExecution(
  tool: AnyToolDefinition,
  rawInput: unknown,
  result: ToolResultV2,
  ctx: ToolContext,
  durationMs: number,
  maxOutputChars: number,
): Promise<void> {
  try {
    const persistResult: ToolResultV2 = result.parts && result.parts.length > 0
      ? { ...result, parts: undefined }
      : result;
    await toolExecutions.create({
      projectId: ctx.projectId ?? null,
      conversationId: ctx.conversationId ?? null,
      messageId: ctx.messageId ?? null,
      toolName: tool.name,
      input: safeStringify(rawInput),
      output: clipAndRedact(result.output, maxOutputChars),
      status: result.status,
      userConfirmed: result.status !== "denied" && !tool.readOnly,
      reversible: result.reversible ?? false,
      durationMs,
      resultJson: serializeResultV2(persistResult),
      errorCode: result.error?.code ?? null,
    });
  } catch (auditErr) {
    console.error("[tools] 写 ToolExecution 审计失败:", auditErr);
  }
}
