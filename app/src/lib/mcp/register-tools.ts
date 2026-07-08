import { mcpServerApprovals, mcpServers } from "@/lib/db";
import type { ToolRegistry } from "@/lib/llm/tools";
import { buildMcpToolDefinitions } from "@/lib/llm/tools/mcp-tool-adapter";
import { callMcpTool, listMcpTools } from "./client";
import { buildLocalMcpSessionScope } from "./session-scope";
import { hydrateMcpServerSecrets } from "./secret-store";

export interface RegisterEnabledMcpToolsOptions {
  workspacePath?: string;
  approveLocalLaunch?: (server: Awaited<ReturnType<typeof mcpServers.listEnabled>>[number], workspacePath?: string) => Promise<boolean>;
}

export async function registerEnabledMcpTools(
  registry: ToolRegistry,
  options: RegisterEnabledMcpToolsOptions = {},
): Promise<void> {
  let servers;
  try {
    servers = await mcpServers.listEnabled();
  } catch (err) {
    console.error("[mcp] 读取 MCP 配置失败:", err);
    return;
  }

  for (const storedServer of servers) {
    try {
      const server = await hydrateMcpServerSecrets(storedServer);
      if (server.transport === "local_stdio") {
        const workspacePath = options.workspacePath ?? "";
        const scope = buildLocalMcpSessionScope(server, options.workspacePath);
        const approval = {
          serverId: server.id,
          workspacePath,
          configFingerprint: scope.configFingerprint,
        };
        if (!(await mcpServerApprovals.isApproved(approval))) {
          const approved = await options.approveLocalLaunch?.(server, options.workspacePath);
          if (!approved) continue;
          await mcpServerApprovals.approve(approval);
        }
      }
      const tools = await listMcpTools(server, options.workspacePath);
      registry.registerAll(buildMcpToolDefinitions({
        serverId: server.id,
        tools,
        callTool: (toolName, input) => callMcpTool(server, toolName, input, options.workspacePath),
      }));
    } catch (err) {
      console.error(`[mcp] 加载 MCP server ${storedServer.name} 失败:`, err);
    }
  }
}
