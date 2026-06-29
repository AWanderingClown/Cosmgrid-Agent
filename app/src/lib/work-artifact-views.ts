import type { ToolExecutionRow } from "@/lib/db";

export type ToolCallViewStatus = "success" | "error" | "denied" | "timeout" | "awaiting_approval";

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

export function deriveToolCallViews(rows: ToolExecutionRow[]): ToolCallView[] {
  return rows.map((row) => {
    const input = safeParseJson(row.input);
    const detailFull = JSON.stringify({ input, output: row.output }, null, 2);
    const meta = summaryMeta(row.toolName, input);
    return {
      id: row.id,
      toolName: row.toolName,
      status: row.status as ToolCallViewStatus,
      shortSummary: summarizeToolCall(row.toolName, input),
      summaryKey: meta.key,
      summaryVars: meta.vars,
      detailPreview: detailFull.slice(0, 240),
      detailFull,
      createdAt: row.createdAt,
      durationMs: row.durationMs,
    };
  });
}
