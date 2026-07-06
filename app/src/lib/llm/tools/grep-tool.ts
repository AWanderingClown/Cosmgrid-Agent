// v0.7 阶段4 — grep 工具（US-4.2：在项目里搜内容）

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { checkPath } from "./path-safety";
import { getFsAdapter } from "./fs-adapter";
import { globToRegExp, walkFiles } from "./walk";

const paramsSchema = z.object({
  pattern: z.string().describe("要搜索的正则表达式"),
  path: z.string().optional().describe("搜索起点（相对工作区），默认整个工作区"),
  include: z.string().optional().describe("只搜匹配此 glob 的文件，如 *.ts"),
});

type GrepParams = z.infer<typeof paramsSchema>;

/** 单次最多返回的匹配行数 */
const GREP_MAX_MATCHES = 200;

export const grepTool: ToolDefinition<GrepParams> = {
  name: "grep",
  description: "在工作区文件里用正则搜索，返回匹配的 文件:行号: 内容。可用 include 限定文件类型。",
  parameters: paramsSchema,
  readOnly: true,
  async execute(input, ctx): Promise<ToolResult> {
    const base = input.path ?? ".";
    const check = await checkPath(ctx.workspacePath, base);
    if (!check.ok) return { status: "denied", output: check.reason ?? "路径不允许" };

    let re: RegExp;
    try {
      re = new RegExp(input.pattern);
    } catch {
      return { status: "error", output: `非法正则：${input.pattern}` };
    }
    const includeRe = input.include ? globToRegExp(input.include) : null;

    const fs = getFsAdapter();
    let files: string[];
    try {
      files = await walkFiles(check.resolved);
    } catch (err) {
      return { status: "error", output: `遍历失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const matches: string[] = [];
    for (const rel of files) {
      if (matches.length >= GREP_MAX_MATCHES) break;
      const name = rel.split("/").pop() ?? rel;
      if (includeRe && !includeRe.test(rel) && !includeRe.test(name)) continue;
      let text: string;
      try {
        text = await fs.readTextFile(`${check.resolved}/${rel}`);
      } catch {
        continue; // 二进制/读不了的跳过
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          matches.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
          if (matches.length >= GREP_MAX_MATCHES) break;
        }
      }
    }

    if (matches.length === 0) {
      return { status: "success", output: `没有匹配 "${input.pattern}" 的内容。` };
    }
    return { status: "success", output: matches.join("\n") };
  },
};
