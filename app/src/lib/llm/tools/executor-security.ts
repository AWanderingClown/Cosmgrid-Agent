import type { AnyToolDefinition, ToolContext, ToolResult } from "./types";
import { checkCommand } from "./command-safety";
import { checkPath, checkWritePath } from "./path-safety";

export type SecurityPrecheck =
  | { denied: ToolResult }
  | { security: ToolContext["security"] };

/**
 * 按 tool.security 声明统一跑路径 / 命令安全检查。
 * 工具本体只声明安全类型，不再各自复制 checkPath/checkCommand。
 */
export async function runSecurityPrecheck(
  tool: AnyToolDefinition,
  parsed: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ctx: ToolContext,
): Promise<SecurityPrecheck> {
  const sec = tool.security;

  if (sec.kind === "read-path") {
    const raw = typeof parsed[sec.pathField] === "string" ? (parsed[sec.pathField] as string).trim() : parsed[sec.pathField];
    if (typeof raw !== "string" || raw === "") return { security: undefined };
    const check = await checkPath(ctx.workspacePath, raw);
    if (!check.ok) return { denied: { status: "denied", output: check.reason ?? "路径不允许" } };
    return { security: { kind: "read-path", resolved: check.resolved } };
  }

  if (sec.kind === "write-path") {
    const raw = typeof parsed[sec.pathField] === "string" ? (parsed[sec.pathField] as string).trim() : parsed[sec.pathField];
    if (typeof raw !== "string" || raw === "") return { security: undefined };
    const check = await checkWritePath(ctx.workspacePath, raw);
    if (!check.ok) return { denied: { status: "denied", output: check.reason ?? "路径不允许" } };
    return { security: { kind: "write-path", resolved: check.resolved, external: check.external } };
  }

  if (sec.kind === "command") {
    const raw = parsed[sec.commandField];
    if (typeof raw !== "string") return { security: undefined };
    const check = checkCommand(raw, ctx.blockedCommands ?? []);
    if (check.verdict === "block") return { denied: { status: "denied", output: `已拦截：${check.reason}` } };
    return { security: { kind: "command", verdict: check.verdict, reason: check.reason } };
  }

  return { security: undefined };
}
