// 2026-07-10 移植 OMO claude-code-compat-core 思路 —— 极简 frontmatter 解析。
//
// 只支持扁平的 `key: value` 标量字段（description/model/argument-hint/name/tools 等），
// 不支持嵌套结构/数组语法——Claude Code 的 commands/agents frontmatter 绝大多数场景
// 就是这种扁平写法，没必要为此引入一个完整 YAML 解析依赖（OMO 用 js-yaml，我们没有这个包，
// 加一个新依赖只为读几行 key: value 不划算）。

export interface ParsedFrontmatter {
  data: Record<string, string>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** 解析 markdown 文件开头的 `---\n...\n---` frontmatter 块，返回扁平字段表 + 正文。
 *  没有 frontmatter 时 data 为空对象，body 为原文。 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { data: {}, body: content.trim() };

  const yamlBlock = match[1] ?? "";
  const body = match[2] ?? "";
  const data: Record<string, string> = {};

  for (const line of yamlBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = stripQuotes(trimmed.slice(colon + 1).trim());
    if (key) data[key] = value;
  }

  return { data, body: body.trim() };
}
