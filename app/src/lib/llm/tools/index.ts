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
import { gitReadTool } from "./git-read-tool";
import { writeTool } from "./write-tool";
import { editTool } from "./edit-tool";
import { bashTool } from "./bash-tool";

export * from "./types";
export { ToolRegistry } from "./registry";
export { executeTool } from "./executor";
export { setFsAdapter, getFsAdapter, type FsAdapter } from "./fs-adapter";
export { setShellAdapter, getShellAdapter, type ShellAdapter } from "./shell-adapter";

/**
 * 工具集。默认只含只读工具（read/glob/grep/git_read）。
 * 传 includeWrite=true 才加入写工具（edit/write）——它们运行时仍强制走 ctx.confirm，
 * 没有确认通道会自我拒绝（双保险）。
 */
export function createDefaultToolRegistry(opts: { includeWrite?: boolean } = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([readTool, globTool, grepTool, gitReadTool]);
  if (opts.includeWrite) registry.registerAll([writeTool, editTool, bashTool]);
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
