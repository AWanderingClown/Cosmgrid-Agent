// MCP 工具适配器（阶段2 增强）：把第三方 MCP server 暴露的工具转成内部 ToolDefinition，
// 同时把对端返回的非结构化结果收敛成 ToolResultV2。
//
// 阶段2 工作项 8："MCP 工具返回做适配，不能假设第三方 MCP 已遵守本协议"——
// 对端可能返回 isError=true / content 里嵌非 text / 超长文本 / 等等，
// 全部走 formatMcpResult + normalizeMcpStatus 收敛成本地统一协议。

import { z } from "zod";
import type { AnyToolDefinition, ToolContext, ToolResultV2Like } from "./types";
import {
  deniedResult,
  errorResult,
  successResult,
  TOOL_MCP_BAD_RESPONSE,
  type ToolResultV2,
} from "./result-contract";

export interface McpToolLike {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolCallResult {
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.record(z.string(), z.unknown());
  const s = schema as {
    type?: string | string[];
    enum?: unknown[];
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
  };
  if (Array.isArray(s.enum) && s.enum.every((item): item is string => typeof item === "string")) {
    return s.enum.length > 0 ? z.enum(s.enum as [string, ...string[]]) : z.never();
  }
  const type = Array.isArray(s.type) ? s.type.find((item) => item !== "null") : s.type;
  if (type === "string") return z.string();
  if (type === "number") return z.number();
  if (type === "integer") return z.number().int();
  if (type === "boolean") return z.boolean();
  if (type === "array") return z.array(jsonSchemaToZod(s.items));
  if (type === "object" || s.properties) {
    const required = new Set(s.required ?? []);
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(s.properties ?? {})) {
      const child = jsonSchemaToZod(value);
      shape[key] = required.has(key) ? child : child.optional();
    }
    return z.object(shape);
  }
  return z.unknown();
}

function sanitizeToolPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * 把 MCP 返回的 content 数组收敛成字符串。
 *
 * 阶段2 兼容策略：
 * - text 块直接拼
 * - 非 text 块（image / audio / resource 等）→ 用 JSON.stringify(item) 占位，附简短提示让模型知道
 *   "这里原本是图片，但当前 UI 不支持透传"，避免模型误把 "[object Object]" 当成内容。
 * - 整个 content 缺失或全是空 → 走 JSON.stringify(result) 兜底（少见，但 raw result 可能含 isError
 *   之外的诊断信息）
 */
function formatMcpResult(result: McpToolCallResult): { text: string; hasNonText: boolean } {
  const items = result.content ?? [];
  if (items.length === 0) {
    return { text: JSON.stringify(result), hasNonText: false };
  }
  const parts: string[] = [];
  let hasNonText = false;
  for (const item of items) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "image" || item.type === "audio" || item.type === "resource") {
      hasNonText = true;
      parts.push(`[MCP ${item.type} content: ${typeof item.data === "string" ? item.data.slice(0, 80) : "..."}]`);
    } else {
      // 未知 type：JSON 序列化兜底，标记 hasNonText 让外层决定要不要警告模型
      hasNonText = true;
      try {
        parts.push(JSON.stringify(item));
      } catch {
        parts.push("[unserializable MCP content item]");
      }
    }
  }
  const text = parts.filter(Boolean).join("\n");
  if (!text.trim()) {
    return { text: JSON.stringify(result), hasNonText };
  }
  return { text, hasNonText };
}

/**
 * 把 MCP 返回包装成本地 ToolResultV2。
 * - isError=true → errorResult{TOOL_MCP_BAD_RESPONSE, retryable=true}（通常重试一次就好，
 *   因为对端可能临时抽风）
 * - content 含非 text 块 → successResult 但 nextActions 提示"非文本内容已被占位，看原始数据
 *   请直接读 result_json"
 * - 正常 text → successResult
 */
function normalizeMcpResult(toolName: string, result: McpToolCallResult): ToolResultV2 {
  const { text, hasNonText } = formatMcpResult(result);

  if (result.isError) {
    return errorResult({
      output: text,
      summary: `MCP ${toolName} 报错`,
      error: {
        code: TOOL_MCP_BAD_RESPONSE,
        rootCauseHint: `MCP server 标记 isError=true：${text.slice(0, 200)}`,
        retryable: true,
        retryInstruction: "MCP 对端可能临时抽风，可以重试一次；持续失败要怀疑对端 server 实现",
        stopCondition: "连续 2 次仍 isError，说明对端不接受当前 input / 资源不存在——停",
      },
    });
  }

  return successResult({
    output: text,
    summary: `MCP ${toolName} 返回 ${text.length} 字符`,
    nextActions: hasNonText
      ? [
          {
            action: "inspect_result_json",
            reason: "返回里包含图片/音频/资源等非文本块，已被占位；要拿原始内容看 tool_executions.result_json",
            safe: true,
          },
        ]
      : [],
  });
}

export function buildMcpToolDefinitions(args: {
  serverId: string;
  tools: readonly McpToolLike[];
  callTool: (toolName: string, input: unknown) => Promise<McpToolCallResult>;
}): AnyToolDefinition[] {
  const serverPart = sanitizeToolPart(args.serverId);
  const usedNames = new Map<string, number>();
  return args.tools.map((tool): AnyToolDefinition => {
    const toolPart = sanitizeToolPart(tool.name);
    const baseName = `mcp__${serverPart || "server"}__${toolPart || "tool"}`;
    const occurrence = (usedNames.get(baseName) ?? 0) + 1;
    usedNames.set(baseName, occurrence);
    return {
      name: occurrence === 1 ? baseName : `${baseName}_${occurrence}`,
      description: tool.description || `MCP tool ${tool.name} from ${args.serverId}`,
      parameters: jsonSchemaToZod(tool.inputSchema),
      readOnly: false,
      // MCP 工具是运行时透传，路径/命令语义不可知，交给对端 server 自己负责；
      // 本地这层只保证 confirm 审批（见下），不套 L6 的三道声明式安全网。
      security: { kind: "none" },
      execute: async (input: unknown, ctx: ToolContext): Promise<ToolResultV2Like> => {
        if (!ctx.confirm) {
          // 没确认通道 → deniedResult（阶段2：MCP 调用是高敏感动作，没有审批通道不能执行）
          return deniedResult({
            output: "MCP 工具需要用户确认，但当前没有确认通道，已拒绝。",
            summary: "MCP 通道缺失",
            reason: "MCP 工具默认需要用户确认",
          });
        }
        const approved = await ctx.confirm({
          toolName: `mcp:${args.serverId}/${tool.name}`,
          summary: `调用 MCP 工具 ${args.serverId}/${tool.name}`,
        });
        if (!approved) {
          return deniedResult({
            output: "用户拒绝调用 MCP 工具。",
            summary: "用户拒绝 MCP 调用",
            reason: "用户在确认弹窗点了拒绝",
          });
        }
        try {
          const result = await args.callTool(tool.name, input);
          return normalizeMcpResult(tool.name, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult({
            output: `MCP ${tool.name} 调用失败：${msg}`,
            summary: `MCP ${tool.name} 抛错`,
            error: {
              code: TOOL_MCP_BAD_RESPONSE,
              rootCauseHint: msg,
              retryable: true,
              retryInstruction: "对端 MCP server 抛错，可能是连接/协议问题，可以重试一次",
              stopCondition: "连续失败说明对端 server 不可用——停",
            },
          });
        }
      },
    };
  });
}