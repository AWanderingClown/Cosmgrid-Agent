// v0.7 阶段4 — 工具执行器
//
// 统一入口：zod 校验参数 → 安全预检 → 执行 → 归一化 ToolResultV2 → 落 ToolExecution 审计。
// 具体职责拆到 executor-* helper，避免执行器继续回到大文件。

import { z } from "zod";
import type { AnyToolDefinition, ToolContext, ToolResult } from "./types";
import { snapshotWrite } from "./git-snapshot";
import { runPostWriteFormatter } from "./post-write-format";
import { collectNestedRulesContext } from "./nested-rules-injector";
import { formatToolParamsError } from "./tool-error-fixhints";
import {
  clipAndRedact,
  compatFromLegacy,
  errorMessage,
  errorResult,
  redactSecret,
  summarize,
  TOOL_DENIED,
  TOOL_INVALID_PARAMS,
  TOOL_UNKNOWN_ERROR,
  type ToolResultV2,
} from "./result-contract";
import { persistToolExecution } from "./executor-audit";
import { maybeBuildDoomLoopResult } from "./executor-doom-loop";
import { summarizePartsForAudit } from "./executor-parts-audit";
import { renderResultForModel } from "./executor-render";
import { normalizeToV2 } from "./executor-result";
import { runSecurityPrecheck } from "./executor-security";
import { safeStringify } from "./executor-serialization";

/** 审计里 output 的截断上限（防超长内容撑爆库）。 */
export const MAX_OUTPUT_CHARS = 10_000;

const errMessage = errorMessage;

/**
 * 执行一个工具并落审计。
 * - 参数校验失败 → TOOL_INVALID_PARAMS
 * - 安全预检拒绝 → TOOL_DENIED
 * - 工具抛错 → TOOL_UNKNOWN_ERROR
 * - 同工具同参数重复过多 → TOOL_DOOM_LOOP
 */
export async function executeTool(
  tool: AnyToolDefinition,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResultV2> {
  const startedAt = Date.now();
  let result: ToolResultV2;

  try {
    const inputJson = safeStringify(rawInput);
    const doomLoopResult = maybeBuildDoomLoopResult(ctx, tool.name, rawInput, inputJson);
    if (doomLoopResult) {
      return await finalizeToolExecution(tool, rawInput, doomLoopResult, ctx, startedAt);
    }

    const parsed = tool.parameters.parse(rawInput);
    const pre = await runSecurityPrecheck(tool, parsed, ctx);

    if ("denied" in pre) {
      result = deniedPrecheckToV2(pre.denied);
    } else {
      result = await runToolBody(tool, parsed, pre.security !== undefined ? { ...ctx, security: pre.security } : ctx);

      if (pre.security?.kind === "write-path" && result.status === "success") {
        const writePath = pre.security.resolved; // 抽常量让 .catch 闭包能拿到（narrowing 跨闭包丢）
        const reversible = await snapshotWrite(ctx.workspacePath, writePath, tool.name);
        void runPostWriteFormatter(writePath)
          // review T-F-5（2026-07-13）：fire-and-forget 之前丢了失败——prettier 崩了用户看不到。
          // 这里仍 fire-and-forget（不快进 tool latency）但错误落 console.error 显式有痕。
          .catch((err: unknown) => {
            console.error(
              `[tools] post-write formatter 失败 (file=${writePath})：`,
              err instanceof Error ? err.message : err,
            );
          });
        result = { ...result, reversible };
      }

      if (
        result.status === "success" &&
        (pre.security?.kind === "read-path" || pre.security?.kind === "write-path")
      ) {
        result = await appendNestedRulesContext(result, ctx, pre.security.resolved);
      }
    }
  } catch (err) {
    result = buildCaughtErrorResult(tool.name, err);
  }

  return await finalizeToolExecution(tool, rawInput, result, ctx, startedAt);
}

async function runToolBody(
  tool: AnyToolDefinition,
  parsed: unknown,
  ctx: ToolContext,
): Promise<ToolResultV2> {
  try {
    const rawResult = await tool.execute(parsed, ctx) as ToolResult | ToolResultV2;
    return normalizeToV2(rawResult);
  } catch (err) {
    return errorResult({
      output: `工具 ${tool.name} 执行失败：${errMessage(err)}`,
      summary: `${tool.name} 抛错`,
      error: {
        code: TOOL_UNKNOWN_ERROR,
        rootCauseHint: errMessage(err),
        retryable: false,
        stopCondition: "无法确定根因，请缩小输入或切更稳定的工具",
      },
    });
  }
}

function deniedPrecheckToV2(legacy: ToolResult): ToolResultV2 {
  const v2 = compatFromLegacy(legacy);
  return {
    ...v2,
    error: {
      code: TOOL_DENIED,
      rootCauseHint: legacy.output,
      retryable: false,
      stopCondition: "等待用户授权或换非写操作路径",
    },
  };
}

async function appendNestedRulesContext(
  result: ToolResultV2,
  ctx: ToolContext,
  resolvedPath: string,
): Promise<ToolResultV2> {
  try {
    const nested = await collectNestedRulesContext(ctx, resolvedPath);
    return nested ? { ...result, output: `${result.output}${nested}` } : result;
  } catch {
    return result;
  }
}

function buildCaughtErrorResult(toolName: string, err: unknown): ToolResultV2 {
  if (err instanceof z.ZodError) {
    const hint = formatToolParamsError(toolName, err);
    return errorResult({
      output: hint,
      summary: `${toolName} 参数错误`,
      error: {
        code: TOOL_INVALID_PARAMS,
        rootCauseHint: hint.split("\n").slice(0, 3).join(" / "),
        retryable: true,
        retryInstruction: "请按上面列表修正参数后重新调用",
      },
      nextActions: [
        {
          action: "fix_params_and_retry",
          reason: "上面的列表给出了每个字段需要补什么，照着改一次",
          safe: true,
        },
      ],
    });
  }

  return errorResult({
    output: `工具 ${toolName} 执行失败：${errMessage(err)}`,
    summary: `${toolName} 抛错`,
    error: {
      code: TOOL_UNKNOWN_ERROR,
      rootCauseHint: errMessage(err),
      retryable: false,
    },
  });
}

async function finalizeToolExecution(
  tool: AnyToolDefinition,
  rawInput: unknown,
  result: ToolResultV2,
  ctx: ToolContext,
  startedAt: number,
): Promise<ToolResultV2> {
  const durationMs = Date.now() - startedAt;
  const withDuration = { ...result, durationMs };
  await persistToolExecution(tool, rawInput, withDuration, ctx, durationMs, MAX_OUTPUT_CHARS);
  return withDuration;
}

export function renderForModel(result: ToolResultV2): string {
  return renderResultForModel(result, MAX_OUTPUT_CHARS);
}

export { summarizePartsForAudit };
export { summarize };
export const truncate = clipAndRedact;
export { redactSecret };
