import type { ToolExecutionRow } from "@/lib/db";
import { deserializeResultV2, type ToolResultV2 } from "@/lib/llm/tools/result-contract";

export type ToolCallViewStatus =
  | "success"
  | "warning"
  | "error"
  | "denied"
  | "timeout"
  | "awaiting_approval";

export interface ToolCallView {
  id: string;
  toolName: string;
  status: ToolCallViewStatus;
  shortSummary: string;
  summaryKey: string;
  summaryVars: Record<string, string | number>;
  detailPreview: string;
  detailFull: string;
  createdAt: string;
  durationMs: number;
  /**
   * 2.1 修复（2026-07-02）：写/改工具成功后是否已 git 快照可回滚。
   * - true  → ✅ 可撤销（用户能看到"已 git 快照可回滚"标记）
   * - false → ⚠️ 无法自动撤销（非 git 仓库 / git 失败，用户必须自己知道这次没保护）
   * - undefined → 该工具无快照概念（read/glob/grep/git_read 等只读工具）
   */
  reversible?: boolean;
  /**
   * 2026-07-04 修复：这次工具调用真实归属的 assistant 消息 id。
   * null = 迁移前的历史记录（当时没有这一列），UI 侧对这些行退回时间戳窗口兜底归属。
   */
  messageId: string | null;
  /**
   * Harness 阶段2（2026-07-11）：结构化错误码（TOOL_DENIED / TOOL_TIMEOUT / TOOL_DOOM_LOOP 等）。
   * 来自 row.errorCode（独立列）或 row.resultJson 解出的 error.code。
   * UI 工具卡可以据此显示"已拦截 / 已超时 / doom loop"等稳定错误标识。
   */
  errorCode: string | null;
  /**
   * 结构化建议下一步（switch_strategy / ask_user / read_back 等），每项含 safe 标记。
   * 来自 v2.nextActions。普通用户 UI 默认折叠不展开，开发者诊断面板可以展开。
   */
  nextActions: Array<{ action: string; reason: string; safe: boolean }>;
  /**
   * 结构化产物引用（file/diff/url/memory/diagnostic）。UI 可以据此渲染可点击入口。
   * 来自 v2.artifacts。
   */
  artifacts: Array<{
    id?: string;
    kind: string;
    uri: string;
    label: string;
    exitCode?: number;
    external?: boolean;
  }>;
}

function safeParseJson(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value : "";
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function statusText(status: string): string {
  if (status === "success") return "已完成";
  if (status === "warning") return "完成但有警告";
  if (status === "denied") return "已取消";
  if (status === "awaiting_approval") return "等待确认";
  if (status === "timeout") return "已超时";
  if (status === "error") return "执行失败";
  return status || "未知";
}

function outputSummary(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "";
  const firstLine = trimmed.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstLine.slice(0, 160);
}

export function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "read":
      return `读取 ${baseName(stringField(input, "file_path") || stringField(input, "path") || "文件")}`;
    case "write":
      return `写入 ${baseName(stringField(input, "file_path") || "文件")}（${countLines(stringField(input, "content"))} 行）`;
    case "edit":
      return `修改 ${baseName(stringField(input, "file_path") || "文件")}`;
    case "bash":
      return `执行命令：${stringField(input, "command").split("\n")[0]?.slice(0, 48) || "命令"}`;
    case "glob":
      return `查找文件：${stringField(input, "pattern") || "*"}`;
    case "grep":
      return `搜索文本：${stringField(input, "pattern") || "关键词"}`;
    case "git_read":
      return "读取 Git 状态";
    default:
      return toolName;
  }
}

function summaryMeta(toolName: string, input: Record<string, unknown>): { key: string; vars: Record<string, string | number> } {
  switch (toolName) {
    case "read":
      return { key: "read", vars: { file: baseName(stringField(input, "file_path") || stringField(input, "path") || "file") } };
    case "write":
      return { key: "write", vars: { file: baseName(stringField(input, "file_path") || "file"), lines: countLines(stringField(input, "content")) } };
    case "edit":
      return { key: "edit", vars: { file: baseName(stringField(input, "file_path") || "file") } };
    case "bash":
      return { key: "bash", vars: { command: stringField(input, "command").split("\n")[0]?.slice(0, 48) || "command" } };
    case "glob":
      return { key: "glob", vars: { pattern: stringField(input, "pattern") || "*" } };
    case "grep":
      return { key: "grep", vars: { pattern: stringField(input, "pattern") || "text" } };
    case "git_read":
      return { key: "git_read", vars: {} };
    default:
      return { key: "unknown", vars: { tool: toolName } };
  }
}

/**
 * 从 ToolExecutionRow 提取 ToolResultV2，老数据（result_json=null）走兼容路径。
 * 阶段2 设计点：errorCode 单独成列是为了 SQL 过滤效率；UI 渲染时 row.errorCode 优先，
 * 缺时再从 v2.error.code 兜底（防御性，正常不会到这一步）。
 */
function parseV2(row: ToolExecutionRow): ToolResultV2 | undefined {
  if (row.resultJson) {
    const parsed = deserializeResultV2(row.resultJson);
    if (parsed) return parsed;
  }
  return undefined;
}

function buildHumanDetail(row: ToolExecutionRow, shortSummary: string, v2?: ToolResultV2): string {
  const lines = [
    `动作：${shortSummary}`,
    `结果：${statusText(row.status)}`,
  ];
  if (v2?.summary) {
    lines.push(`摘要：${v2.summary}`);
  }
  // 阶段2：errorCode 单独显示一行，比"执行失败"更具诊断价值
  const errCode = row.errorCode ?? v2?.error?.code;
  if (errCode) {
    lines.push(`错误码：${errCode}${v2?.error?.retryable ? "（可重试）" : ""}`);
  }
  if (v2?.error?.rootCauseHint) {
    lines.push(`根因：${v2.error.rootCauseHint}`);
  }
  if (v2?.error?.retryInstruction) {
    lines.push(`建议：${v2.error.retryInstruction}`);
  }
  if (v2?.error?.stopCondition) {
    lines.push(`停止条件：${v2.error.stopCondition}`);
  }
  if (v2?.nextActions && v2.nextActions.length > 0) {
    const actions = v2.nextActions
      .map((a) => `${a.action}${a.safe ? "" : "（需用户确认）"}: ${a.reason}`)
      .join(" | ");
    lines.push(`下一步建议：${actions}`);
  }
  if (v2?.artifacts && v2.artifacts.length > 0) {
    const refs = v2.artifacts
      .slice(0, 5)
      .map((a) => `${a.kind}:${a.uri}${a.label ? ` (${a.label})` : ""}`)
      .join(" | ");
    lines.push(`产物：${refs}${v2.artifacts.length > 5 ? ` …等 ${v2.artifacts.length} 个` : ""}`);
  }
  lines.push(`耗时：${row.durationMs}ms`);
  const out = outputSummary(row.output);
  if (out && row.status !== "success") lines.push(`提示：${out}`);
  return lines.join("\n");
}

export function deriveToolCallViews(rows: ToolExecutionRow[]): ToolCallView[] {
  return rows.map((row) => {
    const input = safeParseJson(row.input);
    const meta = summaryMeta(row.toolName, input);
    const shortSummary = summarizeToolCall(row.toolName, input);
    const v2 = parseV2(row);
    const detailFull = buildHumanDetail(row, shortSummary, v2);
    return {
      id: row.id,
      toolName: row.toolName,
      // 阶段2：v2.status 是真相源；老数据 row.status 兼容。warning 单独显示（≠ success）
      status: ((v2?.status ?? row.status) as ToolCallViewStatus),
      // 阶段2：v2.summary 优先（来自 result-contract.summarize，比纯 output 第一行更结构化）
      shortSummary: v2?.summary && v2.summary.length > 0 ? v2.summary : shortSummary,
      summaryKey: meta.key,
      summaryVars: meta.vars,
      detailPreview: detailFull.slice(0, 240),
      detailFull,
      createdAt: row.createdAt,
      durationMs: row.durationMs,
      // 2.1 修复：把 row.reversible 透传到 UI（write/edit 工具的成功结果才有值）
      reversible: row.reversible,
      // 2026-07-04 修复：透传真实 messageId，替代时间戳窗口猜测归属
      messageId: row.messageId,
      // 阶段2：结构化错误码 + 建议下一步 + 产物引用
      errorCode: row.errorCode ?? v2?.error?.code ?? null,
      nextActions: (v2?.nextActions ?? []) as ToolCallView["nextActions"],
      artifacts: (v2?.artifacts ?? []) as ToolCallView["artifacts"],
    };
  });
}
