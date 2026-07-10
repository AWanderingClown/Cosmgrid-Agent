import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { CredentialListItem, ModelListItem } from "@/lib/api";
import type { ToolExecutionRow } from "@/lib/db";
import { buildApiModelEndpoints } from "@/lib/llm/endpoint-list";
import { runChain } from "@/lib/llm/chain-runner";
import type { WorkspaceToolRuntime } from "@/lib/llm/workspace-tool-runtime";
import type { RoleId } from "@/lib/llm/orchestrator";
import type { LanguageModel } from "@/lib/llm/provider-factory";
import type { HarnessVerdict } from "@/lib/llm/harness/feedback";
import {
  createChainRunCallbacks,
  finishChainRun,
  startChainRun,
} from "@/pages/chat/chain-runtime";
import type { ChatMessage } from "@/pages/chat/types";

export interface RunChainExecutionRuntimeArgs {
  chain: RoleId[];
  roleBindings: Map<RoleId, string>;
  controller: AbortController;
  tools: WorkspaceToolRuntime["tools"] | undefined;
  conversationId: string;
  userTask: string;
  judgeModel: LanguageModel | null;
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  getApiKey: (credentialId: string) => Promise<string | null>;
  evalHarness: (args: {
    content: string;
    startedAt: string;
    toolCallCount: number;
    finishReason: string;
    assistantMessageId: string | null;
    judgeModel: LanguageModel | null;
  }) => Promise<HarnessVerdict | null>;
  applyToolExecutionRows: (rows: ToolExecutionRow[]) => void;
  chainAbortRef: MutableRefObject<AbortController | null>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setChainExecutedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  setChainSkippedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  setChainAbortedRole: (role: RoleId | null) => void;
  setChainRunning: (running: boolean) => void;
  t: TFunction;
}

export async function runChainExecutionRuntime(
  args: RunChainExecutionRuntimeArgs,
): Promise<void> {
  if (args.controller.signal.aborted || args.chain.length === 0) return;
  try {
    const endpoints = await buildApiModelEndpoints({
      availableModels: args.availableModels,
      credentials: args.credentials,
      getApiKey: args.getApiKey,
    });
    if (endpoints.length === 0) return;

    startChainRun({
      setChainExecutedRoles: args.setChainExecutedRoles,
      setChainSkippedRoles: args.setChainSkippedRoles,
      setChainAbortedRole: args.setChainAbortedRole,
      setChainRunning: args.setChainRunning,
    });
    const { callbacks, chainPath, getCurrentMessageId } = createChainRunCallbacks({
      chain: args.chain,
      conversationId: args.conversationId,
      setMessages: args.setMessages,
      setChainExecutedRoles: args.setChainExecutedRoles,
      t: args.t,
    });

    args.chainAbortRef.current = args.controller;
    const result = await runChain({
      chain: args.chain,
      userTask: args.userTask,
      controller: args.controller,
      bindings: args.roleBindings,
      models: endpoints,
      tools: args.tools,
      conversationId: args.conversationId,
      getCurrentMessageId,
      harnessCheck: async ({ content, startedAt, toolCallCount, finishReason, assistantMessageId }) =>
        args.evalHarness({
          content,
          startedAt,
          toolCallCount,
          finishReason,
          assistantMessageId: assistantMessageId ?? null,
          judgeModel: args.judgeModel,
        }),
      callbacks,
    });
    await finishChainRun({
      result,
      chainPath,
      conversationId: args.conversationId,
      applyToolExecutionRows: args.applyToolExecutionRows,
      setMessages: args.setMessages,
      setChainSkippedRoles: args.setChainSkippedRoles,
      setChainAbortedRole: args.setChainAbortedRole,
      t: args.t,
    });
  } catch (error) {
    console.error("[chain] 接力执行失败:", error);
  } finally {
    args.setChainRunning(false);
    if (args.chainAbortRef.current === args.controller) args.chainAbortRef.current = null;
  }
}
