import { z } from "zod";
import type { AnyToolDefinition, ToolContext, ToolResult } from "./types";

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

function formatMcpResult(result: McpToolCallResult): string {
  const text = result.content
    ?.map((item) => {
      if (item.type === "text" && typeof item.text === "string") return item.text;
      return JSON.stringify(item);
    })
    .filter(Boolean)
    .join("\n");
  return text || JSON.stringify(result);
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
      execute: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
        const approved = await ctx.confirm?.({
          toolName: `mcp:${args.serverId}/${tool.name}`,
          summary: `调用 MCP 工具 ${args.serverId}/${tool.name}`,
        });
        if (!approved) {
          return { status: "denied", output: "用户拒绝调用 MCP 工具。" };
        }
        const result = await args.callTool(tool.name, input);
        return {
          status: result.isError ? "error" : "success",
          output: formatMcpResult(result),
        };
      },
    };
  });
}
