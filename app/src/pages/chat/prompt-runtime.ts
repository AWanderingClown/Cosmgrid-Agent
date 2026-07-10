import type { LanguageModel } from "@/lib/llm/provider-factory";
import type { ModelListItem } from "@/lib/api";
import type { ChatMsg } from "@/lib/llm/context-compressor";
import {
  applyPromptCompressionWithSummary,
  type PromptCompressionResult,
} from "@/pages/chat/prompt-compression";
import { buildChatPromptMessages } from "@/pages/chat/prompt-messages";
import type { ChatMessage } from "@/pages/chat/types";

export interface PrepareChatPromptRuntimeArgs {
  messages: ChatMessage[];
  effectiveWorkspace: string | null;
  primaryIsCli: boolean;
  projectMemoryPreamble: string | null;
  crossProjectPreamble: string | null;
  workspacePreamble: string | null;
  workflowPreamble: string | null;
  skillPreamble: string | null;
  model: Pick<ModelListItem, "id" | "name" | "displayName" | "contextWindow">;
  smartRoutingEnabled: boolean;
  summarizeModel: LanguageModel | null;
  conversationId: string | null;
  labels: {
    fileTooLarge: (name: string) => string;
    contextTrimmed: (count: number) => string;
  };
}

export interface PreparedChatPromptRuntime extends PromptCompressionResult {
  messages: ChatMsg[];
}

export async function prepareChatPromptRuntime(
  args: PrepareChatPromptRuntimeArgs,
): Promise<PreparedChatPromptRuntime> {
  const promptMessages = buildChatPromptMessages({
    messages: args.messages,
    effectiveWorkspace: args.effectiveWorkspace,
    primaryIsCli: args.primaryIsCli,
    projectMemoryPreamble: args.projectMemoryPreamble,
    crossProjectPreamble: args.crossProjectPreamble,
    workspacePreamble: args.workspacePreamble,
    workflowPreamble: args.workflowPreamble,
    skillPreamble: args.skillPreamble,
    tooLargeNotice: args.labels.fileTooLarge,
    modelLabel: args.model.displayName ?? args.model.name,
  });

  return applyPromptCompressionWithSummary({
    enabled: args.smartRoutingEnabled,
    messages: promptMessages,
    modelName: args.model.name,
    contextWindow: args.model.contextWindow,
    noticeText: args.labels.contextTrimmed,
    summarizeModel: args.summarizeModel ?? undefined,
    persistence: args.conversationId
      ? {
        conversationId: args.conversationId,
        modelId: args.model.id,
        tokenCount: null,
      }
      : undefined,
  });
}
