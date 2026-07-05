import type { ToolExecutionRow } from "@/lib/db";

// 阶段 B：右侧工作面板的工件派生。
// 把 tool_executions 的完整原始行（listByConversation 的结果）派生成「产出物」工件。
// 严格守改动半径——不建 work_items 表，全从已有 tool_executions 派生。
//
// 派生规则：
//   write / edit → file 工件（路径 + content/new_string）
//   bash         → terminal 工件（命令 + output）
//   read / glob / grep / git_read / web_fetch / web_search / todo_write → 跳过（只读探查，不是产出物）
//   未知工具     → 跳过（不臆造）
// input 是 JSON.stringify(rawInput) 的字符串，残缺/非法时降级显示原文，绝不崩。

export type ArtifactKind = "file" | "terminal" | "html";
export type ArtifactStatus = "success" | "error" | "denied";
export type ArtifactAction = "write" | "edit" | "bash";

export interface WorkArtifact {
  id: string;
  kind: ArtifactKind;
  /** 文件路径（file/html）/ 命令（terminal）——一行能看懂的主角 */
  title: string;
  /** 展开看的正文：file 的 content/new_string / terminal 的 output / html 的源代码。可能很长，组件层负责截断折叠 */
  detail: string;
  status: ArtifactStatus;
  createdAt: string;
  action: ArtifactAction;
  /** 只在 kind=file 且 action=edit 时有值（DiffView 用），status=success 时才派生 */
  diffOld?: string;
}

/** 阶段 G：html 派生触发条件（写 .html/.htm/.svg 文件 → html kind，DiffView iframe 沙箱渲染）
 *  - 大小写不敏感（review M4：漏 SVG + 大小写）
 *  - SVG 一并归 html kind（iframe 内可渲染 <svg>，安全边界同 html） */
const HTML_FILE_RE = /\.(html?|svg)$/i;

/** 只读工具不产出工件，跳过 */
const READONLY_TOOLS = new Set(["read", "glob", "grep", "git_read", "web_fetch", "web_search", "todo_write", "ask_user_question"]);

const STATUS_MAP: Record<string, ArtifactStatus> = {
  success: "success",
  ok: "success",
  error: "error",
  denied: "denied",
};

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** 从解析后的 input 对象取一个字符串字段；input 不是对象或字段缺失返回空串 */
function field(obj: unknown, key: string): string {
  if (obj && typeof obj === "object") {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "string" ? v : "";
  }
  return "";
}

function normalizeStatus(s: string): ArtifactStatus {
  return STATUS_MAP[s] ?? "error";
}

/** 把一行 tool_execution 派生成工件；只读/未知工具返回 null */
function deriveOne(row: ToolExecutionRow): WorkArtifact | null {
  if (READONLY_TOOLS.has(row.toolName)) return null;

  const input = safeParseJson(row.input);
  const status = normalizeStatus(row.status);

  if (row.toolName === "write" || row.toolName === "edit") {
    // input: { file_path, content } | { file_path, old_string, new_string }
    const filePath = field(input, "file_path") || row.toolName;
    // write 看新内容全量；edit 看新片段（new_string）
    const detail = row.toolName === "write" ? field(input, "content") : field(input, "new_string");
    // 阶段 G：html 派生（review M2/M4：仅成功时 + 含 SVG + 大小写不敏感）
    const isHtml = status === "success" && HTML_FILE_RE.test(filePath);
    // 阶段 G：diff 派生（review M2：仅 status='success' 才派生 diffOld，避免旧数据或失败 edit 误画 diff）
    const diffOld = status === "success" && row.toolName === "edit" ? field(input, "old_string") : undefined;
    return {
      id: row.id,
      kind: isHtml ? "html" : "file",
      title: filePath,
      detail,
      status,
      createdAt: row.createdAt,
      action: row.toolName === "write" ? "write" : "edit",
      ...(diffOld ? { diffOld } : {}),
    };
  }

  if (row.toolName === "bash") {
    // input: { command }，output 是终端输出（executor 已截断过）
    const command = field(input, "command") || row.output;
    return {
      id: row.id,
      kind: "terminal",
      title: command,
      detail: row.output,
      status,
      createdAt: row.createdAt,
      action: "bash",
    };
  }

  // 未知工具不臆造工件
  return null;
}

/** 派生工件列表（保持 tool_executions 的时间正序）。
 *  吃 listByConversation 的完整原始行——harness 和派生共用同一份查询结果，查一次库。 */
export function deriveArtifacts(rows: ToolExecutionRow[]): WorkArtifact[] {
  return rows.map(deriveOne).filter((a): a is WorkArtifact => a !== null);
}
