// v0.7 阶段4 — 工具执行器
//
// 统一入口：zod 校验参数 → 执行 → 截断输出 → 落 ToolExecution 审计。
// 任何工具的异常都被收敛成 status=error 的结果（不抛给上层，避免一个工具崩了整条对话挂）。

import { z } from "zod";
import { toolExecutions } from "../../db";
import type { AnyToolDefinition, ContentPart, ToolContext, ToolResult } from "./types";
import { checkPath, checkWritePath } from "./path-safety";
import { checkCommand } from "./command-safety";
import { snapshotWrite } from "./git-snapshot";
import { runPostWriteFormatter } from "./post-write-format";
import { collectNestedRulesContext } from "./nested-rules-injector";
import { formatToolParamsError } from "./tool-error-fixhints";

/** 审计里 output 的截断上限（防超长内容撑爆库） */
export const MAX_OUTPUT_CHARS = 10_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n…(truncated)" : s;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 把 ContentPart[] 序列化成给"人 / 审计"看的一句话摘要。
 *
 * 为什么不存 base64：tool_executions 是 SQLite 库，每条 base64 平均 0.5-2MB，
 * 1000 次 view_image 调用就能撑到 1-2GB。把 image 转成"图片 1920×1080 PNG 2.1MB"
 * 之类摘要，模型侧的多模态透传由 buildAiSdkTools 的 parts 字段负责，审计库
 * 只存文本。
 */
export function summarizePartsForAudit(parts: readonly ContentPart[]): string {
  const summaries: string[] = [];
  let textBytes = 0;
  for (const part of parts) {
    if (part.type === "text") {
      textBytes += part.text.length;
      summaries.push(part.text);
    } else if (part.type === "image") {
      const mime = part.mediaType.replace("image/", "");
      const b64Len = part.image.startsWith("data:") ? part.image.split(",", 2)[1]?.length ?? 0 : part.image.length;
      const byteSize = Math.round((b64Len * 3) / 4);
      const kb = (byteSize / 1024).toFixed(1);
      summaries.push(`[image ${mime} ${kb}KB]`);
    }
  }
  if (textBytes > 0) summaries.unshift(`[text ${textBytes}B]`);
  return summaries.join(" | ");
}

type SecurityPrecheck =
  | { denied: ToolResult }
  | { security: ToolContext["security"] };

/**
 * L6 安全网收拢（2026-07-09）：按 tool.security 声明强制跑对应安全检查，工具自己不用
 * 再各自调用 checkPath/checkWritePath/checkCommand——新工具只要声明 kind 就自动受保护，
 * 不再靠写代码的人记得手动调用。
 *
 * read-path/write-path 字段值为空（如 git_read 的可选 path 未传）→ 跳过检查，不是拒绝：
 * 语义上"没传路径"代表"作用于整个工作区"，不等于路径校验失败。
 */
async function runSecurityPrecheck(
  tool: AnyToolDefinition,
  parsed: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ctx: ToolContext,
): Promise<SecurityPrecheck> {
  const sec = tool.security;

  if (sec.kind === "read-path") {
    const raw = typeof parsed[sec.pathField] === "string" ? (parsed[sec.pathField] as string).trim() : parsed[sec.pathField];
    // 空字符串/纯空白视同未传（git_read 的可选 path 场景）：语义是"没指定路径"，不是
    // "路径就是空字符串"，跳过检查而不是拿空字符串去解析出一个奇怪的路径。
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

/**
 * 执行一个工具并落审计。
 * - 参数校验失败 → status=error，不执行
 * - tool.security 声明的前置检查未过 → status=denied，不执行 tool.execute
 * - 执行抛错 → status=error
 * - write-path 类工具成功后：统一 git 快照（写回 reversible）+ 触发写后自动格式化（best-effort）
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
    const pre = await runSecurityPrecheck(tool, parsed, ctx);

    if ("denied" in pre) {
      result = pre.denied;
    } else {
      const execCtx: ToolContext = pre.security !== undefined ? { ...ctx, security: pre.security } : ctx;
      result = await tool.execute(parsed, execCtx);

      if (pre.security?.kind === "write-path" && result.status === "success") {
        const resolved = pre.security.resolved;
        const reversible = await snapshotWrite(ctx.workspacePath, resolved, tool.name);
        void runPostWriteFormatter(resolved);
        result = { ...result, reversible };
      }

      // 2026-07-10 移植 OMO agents-md-core：read/write 命中某个文件成功后，把该文件所在
      // 目录往上到工作区根沿途尚未见过的 CLAUDE.md/AGENTS.md 追加到这次工具输出里
      // （详见 nested-rules-injector.ts）。只对成功且真的落到了具体文件路径的调用生效。
      if (
        result.status === "success" &&
        (pre.security?.kind === "read-path" || pre.security?.kind === "write-path")
      ) {
        try {
          const nested = await collectNestedRulesContext(ctx, pre.security.resolved);
          if (nested) result = { ...result, output: `${result.output}${nested}` };
        } catch {
          // 嵌套规则注入失败不影响工具本身的结果
        }
      }
    }
  } catch (err) {
    // 2026-07-10 移植 OMO delegate-core/retry-patterns 的思路：参数校验失败（zod）时给
    // 逐字段的可执行修复提示，而不是把 ZodError 的原始 JSON 甩给模型自己猜。
    // tool.parameters.parse 是这个 try 块里唯一会抛 ZodError 的地方，其余错误
    // （安全检查/工具业务逻辑）沿用原有的"执行失败："前缀 + 错误消息。
    result =
      err instanceof z.ZodError
        ? { status: "error", output: formatToolParamsError(tool.name, err) }
        : { status: "error", output: `工具 ${tool.name} 执行失败：${errMessage(err)}` };
  }

  const durationMs = Date.now() - startedAt;
  try {
    await toolExecutions.create({
      projectId: ctx.projectId ?? null,
      conversationId: ctx.conversationId ?? null,
      messageId: ctx.messageId ?? null,
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
