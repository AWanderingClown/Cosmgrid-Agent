// v0.7 阶段4 — 工具执行层：工具抽象
//
// 让 AI 能读用户项目文件、按确认写文件、执行白名单命令。这是把产品从"聊天壳"升级成
// "真能干活的工作台"的关键。本文件只定义抽象，不绑定具体后端（fs/shell 由各 tool 实现）。
//
// 设计借鉴 OpenCode tool 抽象 + Claude Code 5 个核心 tool（read/edit/bash/glob/grep）+
// Vercel AI SDK tool()。每个 tool = name + description + zod 参数 schema + execute。

import type { z } from "zod";

/** 工具执行上下文（工作区边界 + 关联实体） */
export interface ToolContext {
  /** 工作区根目录（所有路径必须在此之下，越界拒绝） */
  workspacePath: string;
  projectId?: string;
  conversationId?: string;
  /** 2026-07-04 修复：这次工具调用归属的 assistant 消息 id（调用方在生成该消息时创建，
   *  贯穿整个模型调用透传下来）。有它就不用再靠时间戳窗口猜"这次工具调用是哪条消息做的"——
   *  编排/多角色接力场景下，不同节点的工具调用时间可能穿插，纯时间戳窗口会张冠李戴。 */
  messageId?: string;
  /** 写操作的用户确认回调；返回 false 表示用户拒绝 */
  confirm?: (preview: ToolConfirmRequest) => Promise<boolean>;
  /** 项目自定义的命令黑名单前缀（bash 工具用，叠加在内置危险拦截之上） */
  blockedCommands?: string[];
  /** ask_user_question 工具用：向用户提一个结构化问题，返回用户选中的 label 文本 */
  askUser?: (request: AskUserRequest) => Promise<string>;
}

/** 结构化追问用户时的一个候选选项 */
export interface AskUserOption {
  label: string;
  description?: string;
}

/** ask_user_question 工具的提问请求 */
export interface AskUserRequest {
  question: string;
  options: AskUserOption[];
}

/** 写操作请求用户确认时的展示信息 */
export interface ToolConfirmRequest {
  toolName: string;
  /** 人类可读的操作描述（如 "写入 src/auth.ts（+12 −3 行）"） */
  summary: string;
  /** 可选的 diff 文本（红绿对比） */
  diff?: string;
}

export type ToolStatus = "success" | "error" | "denied" | "timeout";

/** 工具执行结果 */
export interface ToolResult {
  status: ToolStatus;
  /** 给模型看的输出（成功是内容，失败是错误信息） */
  output: string;
  /** 这次执行是否可回滚（写操作有 git commit 则 true） */
  reversible?: boolean;
}

/** 工具定义 */
export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  /** zod 参数 schema（同时用于 LLM tool schema 与运行时校验） */
  parameters: z.ZodType<TInput>;
  /** 只读工具（read/glob/grep/git_status）无需用户确认；写/执行工具为 false */
  readOnly: boolean;
  execute: (input: TInput, ctx: ToolContext) => Promise<ToolResult>;
}

/** 把任意 ToolDefinition 擦除输入类型，便于放进 Registry/列表 */
export type AnyToolDefinition = ToolDefinition<any>;
