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

  // 2026-07-15 review 修复：原来是 for...of 顺序 await，每轮对话（这个函数每发一条消息都
  // 会重新跑一次）只要用户启用的任意一个 MCP server 响应慢/卡住，等它超时（JsonRpcClient
  // 默认 30s，见 client.ts）才会去试下一个——多个 server 时超时时间会累加，一个卡死的
  // server 拖慢整轮对话的发送延迟。改成并行跑（Promise.allSettled），总耗时封顶在
  // "最慢的那一个 server 的超时时间"，不会因为 server 数量累加。approveLocalLaunch
  // 弹确认框这类需要人交互的步骤本来就要等用户，并行对这条路径没有负面影响
  // （不同 server 的确认弹窗本就是各自独立的）。
  const results = await Promise.allSettled(
    servers.map(async (storedServer) => {
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
          if (!approved) return;
          await mcpServerApprovals.approve(approval);
        }
      }
      const tools = await listMcpTools(server, options.workspacePath);
      registry.registerAll(buildMcpToolDefinitions({
        serverId: server.id,
        tools,
        callTool: (toolName, input) => callMcpTool(server, toolName, input, options.workspacePath),
      }));
    }),
  );

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`[mcp] 加载 MCP server ${servers[i]!.name} 失败:`, result.reason);
    }
  });
}
