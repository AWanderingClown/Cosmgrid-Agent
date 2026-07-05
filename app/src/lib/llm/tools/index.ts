// v0.7 阶段4 — 工具层入口：默认注册表 + 转 Vercel AI SDK 工具
//
// createDefaultToolRegistry()：注册当前可用的只读工具（read/glob/grep/git_read/remember/web_fetch/web_search/todo_write/ask_user_question）。
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
import { rememberTool } from "./memory-tool"; // 3.1 修复：AI 写入记忆工具
import { webFetchTool } from "./web-fetch-tool"; // 2026-07-05 新增：唯一的联网能力，只读免确认
import { webSearchTool } from "./web-search-tool"; // 2026-07-05 新增：web_fetch 的另一半，不知道 URL 时搜
import { todoWriteTool } from "./todo-tool"; // 2026-07-05 新增：结构化待办清单，对齐 gemini-cli/opencode/Claude Code
import { askUserTool } from "./ask-user-tool"; // 2026-07-05 新增：结构化追问用户，对齐 gemini-cli/opencode/Claude Code

export * from "./types";
export { ToolRegistry } from "./registry";

/**
 * 工具集。默认只含只读工具（read/glob/grep/git_read/web_fetch/web_search/todo_write/ask_user_question）。
 * 传 includeWrite=true 才加入写工具（edit/write/bash）——它们运行时仍强制走 ctx.confirm，
 * 没有确认通道会自我拒绝（双保险）。
 * 3.1 修复：remember 工具始终可用（不分只读/写），因为记忆写入本身已经走 confirm 审批。
 * 2026-07-05 新增：web_fetch/web_search/todo_write/ask_user_question 同样始终可用——都不改本地文件、
 * 无副作用，跟 read/glob/grep 同档。
 */
export function createDefaultToolRegistry(opts: { includeWrite?: boolean } = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([
    readTool,
    globTool,
    grepTool,
    gitReadTool,
    rememberTool,
    webFetchTool,
    webSearchTool,
    todoWriteTool,
    askUserTool,
  ]);
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
