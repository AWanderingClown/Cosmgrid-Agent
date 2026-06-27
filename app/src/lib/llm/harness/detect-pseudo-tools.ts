// Harness 阶段1 — 检测模型在正文里「演」的伪工具调用文本。
//
// 病根：没绑工作区时 tools 没传，模型凭训练记忆在 content 里吐伪工具调用
// （<run_command>{...}</run_command>、{"name":"view_file","arguments":{...}} 等）。
// 这些不是真工具调用（工具名 run_command/view_file 根本不是项目注册的），是模型幻觉。
// 检测到 → UI 标黄 + 提示「这是模型编的伪工具调用，未实际执行」。
//
// 注意：这跟 parse-thinking 的折叠不同——那是渲染层折叠显示，这是 Harness 层判定违规。

export interface PseudoToolMatch {
  /** 匹配到的原文片段 */
  raw: string;
  /** 伪格式类型 */
  kind: "tag" | "json";
  /** 识别出的伪工具名（run_command / view_file / update_plan 等） */
  toolName?: string;
}

// 伪工具调用 XML 标签名——Harness 检测层与 parse-thinking 渲染折叠层共用，单一来源。
// 加新标签只改这一处，两边自动同步，杜绝检测一套/折叠一套的漂移。
// 覆盖 DB 实测出现过的 run_command/view_file/update_plan + 常见变体 tool/function_calls/execute
// （注意：必须是 function_call(s) 而非 function，否则会误伤 "function foo() {}" 这种正常代码）。
export const PSEUDO_TOOL_TAGS = [
  "run_command",
  "view_file",
  "update_plan",
  "tool_call",
  "tool_response",
  "function_call",
  "function_calls",
  "execute",
  "invoke",
] as const;

// XML 标签式伪工具调用：<run_command>...</run_command> 等
const PSEUDO_TAG_RE = new RegExp(
  `<(${PSEUDO_TOOL_TAGS.join("|")})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`,
  "gi",
);

// 裸 JSON 式伪工具调用：{"name":"xxx","arguments":{...}}
const PSEUDO_JSON_RE = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;

/**
 * 检测文本里的伪工具调用片段。
 * @returns 所有匹配项（原文 + 类型 + 伪工具名）
 */
export function detectPseudoToolCalls(text: string): PseudoToolMatch[] {
  const out: PseudoToolMatch[] = [];
  for (const m of text.matchAll(PSEUDO_TAG_RE)) {
    out.push({ raw: m[0], kind: "tag", toolName: m[1] });
  }
  for (const m of text.matchAll(PSEUDO_JSON_RE)) {
    out.push({ raw: m[0], kind: "json", toolName: m[1] });
  }
  return out;
}

/** 便捷：是否检测到伪工具调用 */
export function hasPseudoToolCalls(text: string): boolean {
  return detectPseudoToolCalls(text).length > 0;
}
