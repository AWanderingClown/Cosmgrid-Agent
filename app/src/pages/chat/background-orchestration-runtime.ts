import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { CredentialListItem, ModelListItem } from "@/lib/api";
import { conversations } from "@/lib/db";
import { planBackgroundOrchestration } from "@/lib/llm/background-orchestration";
import {
  serializeOrchestration,
  type OrchestrationState,
  type OrchestrationTurn,
  type RoleId,
} from "@/lib/llm/orchestrator";
import {
  appendOrchestrationReceiptMessage,
  buildOrchestrationReceipt,
} from "@/pages/chat/orchestration-receipt";
import type { ChatMessage } from "@/pages/chat/types";

export interface RunBackgroundOrchestrationRuntimeArgs {
  conversationId: string;
  activeConversationId: string | null;
  messages: ChatMessage[];
  previousState: OrchestrationState | null;
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  getApiKey: (credentialId: string) => Promise<string | null>;
  leaderModelId: string;
  applyOrchestration: (next: OrchestrationState | null) => void;
  setSelectedModelId: (id: string) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onChainPlan?: (info: { chain: RoleId[]; roleBindings: Map<RoleId, string> }) => void;
  t: TFunction;
}

export async function runBackgroundOrchestrationRuntime(
  args: RunBackgroundOrchestrationRuntimeArgs,
): Promise<void> {
  try {
    const history: OrchestrationTurn[] = args.messages
      .filter((message) => message.kind !== "receipt" && message.content)
      .map((message) => ({ role: message.role, content: message.content }));
    const planned = await planBackgroundOrchestration({
      conversationId: args.conversationId,
      history,
      previousState: args.previousState,
      availableModels: args.availableModels,
      credentials: args.credentials,
      getApiKey: args.getApiKey,
    });
    if (!planned) return;
    const { next, nextWithChain, change, reason, chainPlan, effectiveChainBindings } = planned;
    args.onChainPlan?.({ chain: chainPlan, roleBindings: effectiveChainBindings });

    void conversations
      .saveOrchestration(args.conversationId, serializeOrchestration(nextWithChain))
      .catch(() => {});
    if (args.activeConversationId !== args.conversationId) return;

    args.applyOrchestration(nextWithChain);
    if (!(change.nodeChanged || change.modelChanged)) return;

    if (
      change.node?.role !== "leader" &&
      change.node?.modelId &&
      args.availableModels.some((model) => model.id === change.node!.modelId)
    ) {
      args.setSelectedModelId(change.node.modelId);
    }
    const receipt = buildOrchestrationReceipt({
      change,
      next,
      prev: args.previousState,
      reason,
      availableModels: args.availableModels,
      leaderModelId: args.leaderModelId,
      t: args.t,
    });
    if (receipt) {
      await appendOrchestrationReceiptMessage({
        conversationId: args.conversationId,
        receipt,
        setMessages: args.setMessages,
      });
    }
  } catch {
    // 编排失败静默
  }
}
