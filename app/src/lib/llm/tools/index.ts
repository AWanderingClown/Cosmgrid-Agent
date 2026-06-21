// v0.7 阶段4 — 工具层入口：默认注册表 + 转 Vercel AI SDK 工具
//
// createDefaultToolRegistry()：注册当前可用的只读工具（read/glob/grep）。
// buildAiSdkTools()：把注册表转成 streamText({ tools }) 能吃的格式，execute 走统一 executeTool（含审计）。

import { tool, type Tool } from "ai";
import { ToolRegistry } from "./registry";
import { executeTool } from "./executor";
import type { ToolContext } from "./types";
import { readTool } from "./read-tool";
import { globTool } from "./glob-tool";
import { grepTool } from "./grep-tool";

export * from "./types";
export { ToolRegistry } from "./registry";
export { executeTool } from "./executor";
export { setFsAdapter, getFsAdapter, type FsAdapter } from "./fs-adapter";

/** 当前可用的只读工具集（4a）。写/执行工具（4b）后续加入。 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([readTool, globTool, grepTool]);
  return registry;
}

/**
 * 把注册表里的工具转成 Vercel AI SDK 的 tools 映射，挂到 streamText({ tools })。
 * 每个工具的 execute 走统一 executeTool（zod 校验 + 审计 + 错误收敛）。
 */
export function buildAiSdkTools(registry: ToolRegistry, ctx: ToolContext): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const def of registry.list()) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: def.parameters,
      execute: async (input: unknown) => {
        const res = await executeTool(def, input, ctx);
        return res.output;
      },
    });
  }
  return out;
}
