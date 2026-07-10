import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { CredentialListItem, ModelListItem } from "@/lib/api";
import type { ToolExecutionRow } from "@/lib/db";
import type { OrchestrationState, RoleId } from "@/lib/llm/orchestrator";
import { shouldAutoRunChain, shouldRunBackgroundOrchestration } from "@/lib/llm/orchestration-gating";
import type { LanguageModel } from "@/lib/llm/provider-factory";
import type { WorkspaceToolRuntime } from "@/lib/llm/workspace-tool-runtime";
import type { HarnessVerdict } from "@/lib/llm/harness/feedback";
import type { TurnIntentDecision } from "@/lib/workflow/types";
import { runBackgroundOrchestrationRuntime } from "@/pages/chat/background-orchestration-runtime";
import { runChainExecutionRuntime } from "@/pages/chat/chain-execution-runtime";
import type { ChatMessage } from "@/pages/chat/types";

export interface RunPostStreamOrchestrationRuntimeArgs {
  conversationId: string | null;
  activeConversationId: string | null;
  finalContent: string | undefined;
  finalAssistantMsg: ChatMessage | null | undefined;
  pureMode: boolean;
  controller: AbortController;
  text: string;
  taskRole: string;
  hasWorkspace: boolean;
  intentDecision: TurnIntentDecision;
  newMessages: ChatMessage[];
  orchestrationState: OrchestrationState | null;
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  getApiKey: (credentialId: string) => Promise<string | null>;
  leaderModelId: string;
  applyOrchestration: (next: OrchestrationState | null) => void;
  setSelectedModelId: (id: string) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  tools: WorkspaceToolRuntime["tools"] | undefined;
  userTask: string;
  judgeModel: LanguageModel | null;
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
  setChainExecutedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  setChainSkippedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  setChainAbortedRole: (role: RoleId | null) => void;
  setChainRunning: (running: boolean) => void;
  t: TFunction;
}

export async function runPostStreamOrchestrationRuntime(
  args: RunPostStreamOrchestrationRuntimeArgs,
): Promise<void> {
  if (!args.conversationId || !args.finalContent || !args.finalAssistantMsg) return;
  if (args.pureMode || args.controller.signal.aborted) return;
  if (
    !shouldRunBackgroundOrchestration({
      text: args.text,
      taskRole: args.taskRole,
      hasWorkspace: args.hasWorkspace,
      intentAction: args.intentDecision.action,
    })
  ) {
    return;
  }

  await runBackgroundOrchestrationRuntime({
    conversationId: args.conversationId,
    activeConversationId: args.activeConversationId,
    messages: [...args.newMessages, args.finalAssistantMsg],
    previousState: args.orchestrationState,
    availableModels: args.availableModels,
    credentials: args.credentials,
    getApiKey: args.getApiKey,
    leaderModelId: args.leaderModelId,
    applyOrchestration: args.applyOrchestration,
    setSelectedModelId: args.setSelectedModelId,
    setMessages: args.setMessages,
    onChainPlan: ({ chain, roleBindings }) => {
      if (chain.length === 0 || args.controller.signal.aborted) return;
      if (!shouldAutoRunChain({ text: args.text, chain, decision: args.intentDecision })) return;
      void runChainExecutionRuntime({
        chain,
        roleBindings,
        controller: args.controller,
        tools: args.tools,
        conversationId: args.conversationId!,
        userTask: args.userTask,
        judgeModel: args.judgeModel,
        availableModels: args.availableModels,
        credentials: args.credentials,
        getApiKey: args.getApiKey,
        evalHarness: args.evalHarness,
        applyToolExecutionRows: args.applyToolExecutionRows,
        chainAbortRef: args.chainAbortRef,
        setMessages: args.setMessages,
        setChainExecutedRoles: args.setChainExecutedRoles,
        setChainSkippedRoles: args.setChainSkippedRoles,
        setChainAbortedRole: args.setChainAbortedRole,
        setChainRunning: args.setChainRunning,
        t: args.t,
      });
    },
    t: args.t,
  });
}
