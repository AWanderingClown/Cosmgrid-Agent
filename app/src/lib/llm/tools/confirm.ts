// v0.7 阶段4b — 用户确认门（写/执行工具共用的安全闸）
//
// 把"没有确认通道=拒绝 / 用户拒绝=拒绝"这道闸收口到一处，三个高危工具复用，
// 避免各自实现走样（安全代码的单点更可审计）。

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
