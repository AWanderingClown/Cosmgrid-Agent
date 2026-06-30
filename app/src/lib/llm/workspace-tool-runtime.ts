import type { Tool } from "ai";
import { buildAiSdkTools, createDefaultToolRegistry, type ToolConfirmRequest } from "./tools";
import { buildWorkspacePreamble } from "./workspace-context";

export interface WorkspaceToolRuntimeOptions {
  workspacePath?: string | null;
  includeWrite: boolean;
  projectId?: string;
  conversationId?: string;
  confirm?: (preview: ToolConfirmRequest) => Promise<boolean>;
  blockedCommands?: string[];
  includePreamble?: boolean;
}

export interface WorkspaceToolRuntime {
  tools?: Record<string, Tool>;
  workspacePreamble: string | null;
}

/**
 * 构造一轮模型调用要用的工作区工具。
 * 工具构建和项目说明读取故意分开容错：说明读取失败不能连坐工具能力。
 */
export async function prepareWorkspaceToolRuntime(
  options: WorkspaceToolRuntimeOptions,
): Promise<WorkspaceToolRuntime> {
  if (!options.workspacePath) return { workspacePreamble: null };

  let tools: Record<string, Tool> | undefined;
  let workspacePreamble: string | null = null;

  try {
    tools = buildAiSdkTools(createDefaultToolRegistry({ includeWrite: options.includeWrite }), {
      workspacePath: options.workspacePath,
      projectId: options.projectId,
      conversationId: options.conversationId,
      confirm: options.confirm,
      blockedCommands: options.blockedCommands,
    });
  } catch (err) {
    console.error("[tools] 构建工具失败:", err);
  }

  if (options.includePreamble) {
    try {
      workspacePreamble = await buildWorkspacePreamble(options.workspacePath, { includeWrite: options.includeWrite });
    } catch (err) {
      console.error("[tools] 读项目自述失败（不影响工具）:", err);
    }
  }

  return { tools, workspacePreamble };
}
