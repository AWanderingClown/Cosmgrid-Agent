// v0.7 阶段4 — glob 工具（US-4.2 配套：按模式找文件）

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { checkPath } from "./path-safety";
import { globToRegExp, walkFiles } from "./walk";

const paramsSchema = z.object({
  pattern: z.string().describe("glob 模式，如 src/**/*.ts"),
  path: z.string().optional().describe("搜索起点（相对工作区），默认整个工作区"),
});

type GlobParams = z.infer<typeof paramsSchema>;

/** 单次最多返回的匹配文件数 */
const GLOB_MAX_RESULTS = 200;

export const globTool: ToolDefinition<GlobParams> = {
  name: "glob",
  description: "按 glob 模式（如 src/**/*.ts）在工作区里查找文件，返回匹配的相对路径列表。",
  parameters: paramsSchema,
  readOnly: true,
  async execute(input, ctx): Promise<ToolResult> {
    const base = input.path ?? ".";
    const check = await checkPath(ctx.workspacePath, base);
    if (!check.ok) return { status: "denied", output: check.reason ?? "路径不允许" };

    const re = globToRegExp(input.pattern);
    let files: string[];
    try {
      files = await walkFiles(check.resolved);
    } catch (err) {
      return { status: "error", output: `遍历失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const matched = files.filter((f) => re.test(f)).slice(0, GLOB_MAX_RESULTS);
    if (matched.length === 0) {
      return { status: "success", output: `没有匹配 "${input.pattern}" 的文件。` };
    }
    return { status: "success", output: matched.join("\n") };
  },
};
