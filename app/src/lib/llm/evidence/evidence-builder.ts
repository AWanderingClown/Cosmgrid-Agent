// Harness 工程实施计划 阶段3 — Evidence Builder（证据装配）。
//
// 把 ToolExecutionRow[] + ToolArtifactRef[] 装配成 EvidenceRef[]。
// ID 用 crypto.randomUUID()；UI/审计通过 id 反查。
//
// 复用 fabrication-evidence.ts 的 `selectRowsForMessage` 做 messageId 优先归属（计划文件 §关键复用）：
// - 同一会话多角色工具记录不串消息（测试场景 #4）
// - legacy messageId=null 数据走 sinceIso 时间兜底（测试场景 #5）
//
// 注意：selectRowsForMessage 在 fabrication-evidence.ts 里是导出函数，
// 阶段3 这里直接 import（同层 L8 → L8 合法，无循环依赖风险）。
// evidence-builder 本身不依赖 workflow/，所以不引入新的 depcruise 规则冲突。

import { selectRowsForMessage } from "@/lib/llm/harness/fabrication-evidence";
import type { ToolArtifactRef } from "@/lib/llm/tools/result-contract";
import type { ToolExecutionRow } from "@/lib/db";
import type { EvidenceRef } from "./types";

export interface BuildEvidenceArgs {
  /** 原始全部 exec rows（已经在调用方按 messageId + 时间窗口粗筛过）。 */
  execRows: ToolExecutionRow[];
  /** assistantMessageId：归属锚点。 */
  assistantMessageId: string;
  /** 兜底时间窗（ISO），legacy messageId=null 的 row 用 createdAt >= sinceIso 收。 */
  sinceIso: string;
  /** 阶段2 工具返回的 artifacts（来自 ToolResultV2.artifacts）。 */
  artifacts?: ToolArtifactRef[];
  /** 关联的 workflow runId + nodeId（用于审计回溯）。 */
  workflowRef?: { runId: string; nodeId: string };
}

/**
 * 主入口：归属 + 装配 + 截断标记。
 * 返回的 EvidenceRef[] 包含三类：
 *   1. kind=tool_execution：每条归属到的 ToolExecutionRow 一条
 *   2. kind=artifact：每个 ToolArtifactRef 一条
 *   3. kind=structured_criterion：当前未自动注入，留给 task-verifier 注入
 */
export function buildEvidenceRefs(args: BuildEvidenceArgs): EvidenceRef[] {
  const owned = selectRowsForMessage(args.execRows, {
    assistantMessageId: args.assistantMessageId,
    sinceIso: args.sinceIso,
  });
  const now = new Date().toISOString();
  const refs: EvidenceRef[] = [];
  for (const row of owned) {
    refs.push({
      id: crypto.randomUUID(),
      kind: "tool_execution",
      source: row.toolName,
      summary: summarizeRow(row),
      occurredAt: row.createdAt,
      toolExecutionId: row.id,
      truncated: detectTruncation(row),
      ...(args.workflowRef ? { workflowRef: args.workflowRef } : {}),
    });
  }
  for (const artifact of args.artifacts ?? []) {
    refs.push({
      id: crypto.randomUUID(),
      kind: "artifact",
      source: `${artifact.kind}:${artifact.uri}`,
      summary: artifact.label || `${artifact.kind} ${artifact.uri}`,
      occurredAt: now,
      artifact,
      ...(args.workflowRef ? { workflowRef: args.workflowRef } : {}),
    });
  }
  return refs;
}

/** 单行 audit 的人类可读摘要。 */
function summarizeRow(row: ToolExecutionRow): string {
  const out = (row.output ?? "").split("\n", 1)[0]?.trim() ?? "";
  if (out) return out.slice(0, 120);
  return `${row.toolName} (${row.status})`;
}

/** 检测一行 audit 是否被截断（output / resultJson 超长 / 解析失败）。 */
function detectTruncation(row: ToolExecutionRow): boolean {
  // executor 阶段已经 cap 在 MAX_OUTPUT_CHARS（10K）；这里把"工具抛错"也标 truncated 以便
  // Task Verifier 把 verdict 标 unknown 而不是 supported —— 错误状态不算有效证据。
  if (row.status === "error" || row.status === "denied" || row.status === "timeout") return true;
  // resultJson 解析失败 = 完整结构化结果丢失
  if (row.resultJson) {
    try {
      JSON.parse(row.resultJson);
    } catch {
      return true;
    }
  }
  return false;
}