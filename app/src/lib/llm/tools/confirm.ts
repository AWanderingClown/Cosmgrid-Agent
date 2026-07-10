// v0.7 阶段4b — 用户确认门（写/执行工具共用的安全闸）
//
// 把"没有确认通道=拒绝 / 用户拒绝=拒绝"这道闸收口到一处，三个高危工具复用，
// 避免各自实现走样（安全代码的单点更可审计）。
//
// 阶段2（2026-07-11）审查修复：抽出 requireApprovalAsV2 helper —— 之前 5 个写工具
// （write/edit/hashline_edit/bash/memory）各自重复 12 行 `requireApproval + if denied
// return deniedResult({...})` 模板，现在调用方压成 2 行。

import { deniedResult, type ToolResultV2 } from "./result-contract";
import type { ToolConfirmRequest, ToolContext, ToolResult } from "./types";

/**
 * 请求用户确认。
 * - 返回 null：已确认，调用方继续执行
 * - 返回 ToolResult(denied)：无确认通道 或 用户拒绝，调用方原样返回它
 */
export async function requireApproval(
  ctx: ToolContext,
  request: ToolConfirmRequest,
): Promise<ToolResult | null> {
  if (!ctx.confirm) {
    return { status: "denied", output: "高危操作需要用户确认，但当前没有确认通道，已拒绝。" };
  }
  const approved = await ctx.confirm(request);
  if (!approved) {
    return { status: "denied", output: "用户拒绝了该操作。" };
  }
  return null;
}

/**
 * 阶段2 抽取：把 requireApproval + deniedResult 翻 ToolResultV2 合并成 2 行调用。
 * 返回 null 表示用户已确认，调用方继续；返回 ToolResultV2 表示已拒绝（denied 状态，
 * error.code=TOOL_DENIED + retryable=false），调用方直接 return。
 *
 * 用法：
 *   const denied = await requireApprovalAsV2(ctx, {...}, "用户拒绝 write");
 *   if (denied) return denied;
 */
export async function requireApprovalAsV2(
  ctx: ToolContext,
  request: ToolConfirmRequest,
  deniedSummary: string,
): Promise<ToolResultV2 | null> {
  const deniedLegacy = await requireApproval(ctx, request);
  if (!deniedLegacy) return null;
  return deniedResult({
    output: deniedLegacy.output,
    summary: deniedSummary,
    reason: deniedLegacy.output,
  });
}
