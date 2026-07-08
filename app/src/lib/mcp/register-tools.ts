import { mcpServers } from "@/lib/db";
import type { ToolRegistry } from "@/lib/llm/tools";
import { buildMcpToolDefinitions } from "@/lib/llm/tools/mcp-tool-adapter";
import { callMcpTool, listMcpTools } from "./client";

export async function registerEnabledMcpTools(registry: ToolRegistry, workspacePath?: string): Promise<void> {
  let servers;
  try {
    servers = await mcpServers.listEnabled();
  } catch (err) {
    console.error("[mcp] 读取 MCP 配置失败:", err);
    return;
  }

  for (const server of servers) {
    try {
      const tools = await listMcpTools(server, workspacePath);
      registry.registerAll(buildMcpToolDefinitions({
        serverId: server.id,
        tools,
        callTool: (toolName, input) => callMcpTool(server, toolName, input, workspacePath),
      }));
    } catch (err) {
      console.error(`[mcp] 加载 MCP server ${server.name} 失败:`, err);
    }
  }
}
