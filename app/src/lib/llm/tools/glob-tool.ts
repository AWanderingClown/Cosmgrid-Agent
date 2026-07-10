// v0.7 阶段4 — glob 工具（US-4.2 配套：按模式找文件）

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { globToRegExp, walkFiles } from "./walk";

const paramsSchema = z.object({
  pattern: z.string().describe("glob 模式，如 src/**/*.ts"),
  // .default(".") 而非 execute 内部 `input.path ?? "."`：executor 的声明式 read-path 检查
  // 直接读 zod parse 后的字段值，默认值必须在 schema 层面就落地，否则 executor 会把
  // "字段未传" 误判成 git_read 那种"跳过检查"的可选路径语义。
  path: z.string().default(".").describe("搜索起点（相对工作区），默认整个工作区"),
});

type GlobParams = z.infer<typeof paramsSchema>;

/** 单次最多返回的匹配文件数 */
const GLOB_MAX_RESULTS = 200;

export const globTool: ToolDefinition<GlobParams> = {
  name: "glob",
  description: "按 glob 模式（如 src/**/*.ts）在工作区里查找文件，返回匹配的相对路径列表。",
  parameters: paramsSchema,
  readOnly: true,
  security: { kind: "read-path", pathField: "path" },
  async execute(input, ctx): Promise<ToolResult> {
    if (ctx.security?.kind !== "read-path") throw new Error("glob 工具必须经 executeTool 调用（缺 ctx.security）");
    const resolved = ctx.security.resolved;

    const re = globToRegExp(input.pattern);
    let files: string[];
    try {
      files = await walkFiles(resolved);
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
