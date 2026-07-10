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
import { hashlineEditTool } from "./hashline-edit-tool"; // 2026-07-10 移植 OMO hashline：按行 hash 引用编辑，与 editTool 并存
import { bashTool } from "./bash-tool";
import { rememberTool } from "./memory-tool"; // 3.1 修复：AI 写入记忆工具
import { webFetchTool } from "./web-fetch-tool"; // 2026-07-05 新增：唯一的联网能力，只读免确认
import { webSearchTool } from "./web-search-tool"; // 2026-07-05 新增：web_fetch 的另一半，不知道 URL 时搜
import { todoWriteTool } from "./todo-tool"; // 2026-07-05 新增：结构化待办清单，对齐 gemini-cli/opencode/Claude Code
import { askUserTool } from "./ask-user-tool"; // 2026-07-05 新增：结构化追问用户，对齐 gemini-cli/opencode/Claude Code
import { lspDefinitionTool, lspDiagnosticsTool, lspHoverTool } from "./lsp-tools";
import { viewImageTool } from "./view-image-tool"; // 2026-07-09 新增：模型自主读取工作区图片
import { getModelToolCallSupport, getModelVisionSupport } from "../model-limits"; // 2026-07-10 OMO-7 capability guardrail

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
/**
 * view_image 工具始终注册（2026-07-09 剩余问题汇总第 14 项）。
 *
 * Provider 兼容性：Anthropic 原生支持 tool_result 嵌 image（@ai-sdk/anthropic 直接透传）；
 * OpenAI / Google 落地验证前 model 会拒收带 parts 的 tool result，但这是 provider 层
 * 抛错，被 Vercel AI SDK 兜成 tool_result error 注入下一轮，**不阻断主对话**。
 *
 * 因此选择"无条件注册 + provider 自行决定是否接受 parts"，而不是"按 provider 过滤注册"——
 * 后者需要把 provider 信息穿透到 tool 层（workspace-tool-runtime.ts → chat-fallback-attempt.ts），
 * 跨层耦合收益小（拒收错误已被 SDK 兜住），保持简单。
 *
 * 后续如果某个 provider 拒收 parts 时表现得过于激进（abort 整轮调用），再补 model-capabilities
 * 矩阵在 buildAiSdkTools 灰度分支里跳过 content 字段。
 */
export function createDefaultToolRegistry(opts: { includeWrite?: boolean; modelName?: string } = {}): ToolRegistry {
  const registry = new ToolRegistry();

  // 2026-07-10 OMO-7 capability guardrail：models.dev 明确说这个模型不支持工具调用
  // （getModelToolCallSupport === false，不是"查不到"的 undefined）→ 整个工具集不给，
  // 不确定时仍按"支持"处理——只拦截"明确说不支持"这一种情况，避免误伤覆盖不全的模型。
  if (opts.modelName && getModelToolCallSupport(opts.modelName) === false) {
    return registry;
  }

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
    lspDiagnosticsTool,
    lspDefinitionTool,
    lspHoverTool,
  ]);
  // view_image 单独按视觉能力判断：明确不支持视觉的模型不注册，省一次必然被 provider 拒收的调用
  if (!opts.modelName || getModelVisionSupport(opts.modelName) !== false) {
    registry.register(viewImageTool);
  }
  if (opts.includeWrite) registry.registerAll([writeTool, editTool, hashlineEditTool, bashTool]);
  return registry;
}

/**
 * 把注册表里的工具转成 Vercel AI SDK 的 tools 映射，挂到 streamText({ tools })。
 * 每个工具的 execute 走统一 executeTool（zod 校验 + 审计 + 错误收敛）。
 *
 * 多模态返回（2026-07-09 view_image 工具新增）：若 ToolResult 含 parts 字段，
 * 转成 AI SDK v6 的 { content: ContentPart[] } 形态，让 provider 透传给模型；
 * 否则走旧的 output 字符串路径——所有老工具零影响。
 *
 * 为什么灰度分支：AI SDK 6 的 ToolResultUnion 接受 string 或 { content: [...] }，
 * 老工具没 parts 走 string，view_image 有 parts 走 content 形态；这是 SDK 官方推荐用法。
 */
export function buildAiSdkTools(registry: ToolRegistry, ctx: ToolContext): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const def of registry.list()) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: def.parameters,
      execute: async (input: unknown) => {
        const res = await executeTool(def, input, ctx);
        if (res.parts && res.parts.length > 0) {
          return { content: res.parts };
        }
        return res.output;
      },
    });
  }
  return out;
}
