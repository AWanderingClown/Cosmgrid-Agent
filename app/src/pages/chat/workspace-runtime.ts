import { desktopDir } from "@tauri-apps/api/path";
import type { ToolConfirmRequest, AskUserRequest } from "@/lib/llm/tools";
import { buildWorkspacePreamble } from "@/lib/llm/workspace-context";
import {
  prepareWorkspaceToolRuntime,
  type WorkspaceToolRuntime,
} from "@/lib/llm/workspace-tool-runtime";
import { formatLocalMcpLaunch } from "@/lib/mcp/session-scope";

export interface PrepareChatWorkspaceRuntimeArgs {
  workspacePath: string | null;
  primaryIsCli: boolean;
  includeWriteTools: boolean;
  conversationId: string | null;
  assistantId: string;
  permissionMode: "read" | "confirm" | "auto";
  requestConfirm: (req: ToolConfirmRequest) => Promise<boolean>;
  requestAskUser: (req: AskUserRequest) => Promise<string>;
  getDesktopPath?: () => Promise<string | null>;
  stopIfAborted: () => boolean;
}

export interface PreparedChatWorkspaceRuntime {
  aborted: boolean;
  desktopPath: string | null;
  tools?: WorkspaceToolRuntime["tools"];
  workspacePreamble: string | null;
}

export async function prepareChatWorkspaceRuntime(
  args: PrepareChatWorkspaceRuntimeArgs,
): Promise<PreparedChatWorkspaceRuntime> {
  const desktopPath = await (args.getDesktopPath ?? (() => desktopDir().catch(() => null)))();
  const writableDesktopPath = args.includeWriteTools ? desktopPath : null;

  if (args.workspacePath) {
    if (args.primaryIsCli) {
      const workspacePreamble = await buildWorkspacePreamble(args.workspacePath, {
        includeWrite: args.includeWriteTools,
        desktopPath: writableDesktopPath,
      });
      return {
        aborted: args.stopIfAborted(),
        desktopPath,
        workspacePreamble,
      };
    }

    const runtime = await prepareWorkspaceToolRuntime({
      workspacePath: args.workspacePath,
      includeWrite: args.includeWriteTools,
      conversationId: args.conversationId ?? undefined,
      messageId: args.assistantId,
      confirm: args.permissionMode === "auto" ? async () => true : args.requestConfirm,
      approveMcpLaunch: (server, workspacePath) => args.requestConfirm({
        toolName: `mcp-server:${server.name}`,
        summary: `允许启动本地 MCP server？\n${formatLocalMcpLaunch(server, workspacePath)}`,
      }),
      askUser: args.requestAskUser,
      includePreamble: true,
      desktopPath: writableDesktopPath,
    });
    return {
      aborted: args.stopIfAborted(),
      desktopPath,
      tools: runtime.tools,
      workspacePreamble: runtime.workspacePreamble,
    };
  }

  if (!args.primaryIsCli) {
    const runtime = await prepareWorkspaceToolRuntime({
      includeWrite: false,
      conversationId: args.conversationId ?? undefined,
      messageId: args.assistantId,
      confirm: args.permissionMode === "auto" ? async () => true : args.requestConfirm,
      approveMcpLaunch: (server, workspacePath) => args.requestConfirm({
        toolName: `mcp-server:${server.name}`,
        summary: `允许启动本地 MCP server？\n${formatLocalMcpLaunch(server, workspacePath)}`,
      }),
      askUser: args.requestAskUser,
    });
    return {
      aborted: args.stopIfAborted(),
      desktopPath,
      tools: runtime.tools,
      workspacePreamble: null,
    };
  }

  return {
    aborted: false,
    desktopPath,
    workspacePreamble: null,
  };
}
