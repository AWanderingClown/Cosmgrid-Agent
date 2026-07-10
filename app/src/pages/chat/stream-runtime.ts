import type { Dispatch, SetStateAction } from "react";
import type { RoleId } from "@/lib/llm/orchestrator";
import {
  streamWithFallback,
  type ModelEndpoint,
  type StreamUsage,
  type StreamWithFallbackOptions,
} from "@/lib/llm/chat-fallback";
import {
  detectIntentNoToolCall,
  isClean,
  type HarnessVerdict,
} from "@/lib/llm/harness/feedback";
import { decideStreamRetry } from "@/pages/chat/stream-retry";
import {
  createStreamingTurnCallbacks,
  createStreamingTurnState,
  type StreamingTurnState,
} from "@/pages/chat/streaming-callbacks";
import type { ChatMessage } from "@/pages/chat/types";

export interface RunChatStreamRuntimeArgs {
  chain: ModelEndpoint[];
  initialMessages: Parameters<typeof streamWithFallback>[1];
  assistantId: string;
  controller: AbortController;
  modelId: string;
  conversationId: string | null;
  taskRole: string;
  actorRole: RoleId;
  routingDecision: StreamWithFallbackOptions["routingDecision"];
  compressionStats: { beforeTokens: number; afterTokens: number } | null;
  tools?: StreamWithFallbackOptions["tools"];
  pureMode: boolean;
  turnImpliesWrite: boolean;
  turnStartedAt: string;
  evalHarness: (args: {
    content: string;
    actualToolCallCount: number;
    assistantMessageId: string;
    finishReason: string;
  }) => Promise<HarnessVerdict | null>;
  labels: {
    harnessRetry: string;
    intentNudgeRetry: string;
    switchedTo: (name: string) => string;
  };
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setSwitchNotice: Dispatch<SetStateAction<string | null>>;
  setLastUsage: Dispatch<SetStateAction<StreamUsage | null>>;
  setHarnessNotice: Dispatch<SetStateAction<string | null>>;
}

export interface RunChatStreamRuntimeResult extends StreamingTurnState {
  aborted: boolean;
}

const MAX_HARNESS_RETRY = 1;

export async function runChatStreamRuntime(
  args: RunChatStreamRuntimeArgs,
): Promise<RunChatStreamRuntimeResult> {
  const streamingState = createStreamingTurnState(args.modelId);
  let convo = args.initialMessages;
  let forceToolChoiceRequired = false;

  for (let attempt = 0; ; attempt++) {
    streamingState.fullContent = "";
    if (attempt > 0) {
      args.setMessages((prev) =>
        prev.map((message) =>
          message.id === args.assistantId
            ? { ...message, content: "", harness: undefined }
            : message,
        ),
      );
    }
    const result = await streamWithFallback(
      args.chain,
      convo,
      createStreamingTurnCallbacks({
        assistantId: args.assistantId,
        controller: args.controller,
        state: streamingState,
        t: ((key: string, values?: Record<string, unknown>) => {
          if (key === "chat.switchedTo") return args.labels.switchedTo(String(values?.name ?? ""));
          return key;
        }) as never,
        setMessages: args.setMessages,
        setSwitchNotice: args.setSwitchNotice,
        setLastUsage: args.setLastUsage,
      }),
      {
        signal: args.controller.signal,
        conversationId: args.conversationId ?? undefined,
        role: args.taskRole,
        actorRole: args.actorRole,
        ...(args.routingDecision ? { routingDecision: args.routingDecision } : {}),
        ...(args.compressionStats ? { compressionStats: args.compressionStats } : {}),
        ...(args.tools
          ? {
            tools: args.tools,
            maxToolSteps: 12,
            ...(forceToolChoiceRequired ? { toolChoice: "required" as const } : {}),
          }
          : {}),
      },
    );
    streamingState.lastResultModelId = result.usedModelId;
    if (args.controller.signal.aborted) {
      return { ...streamingState, aborted: true };
    }

    const verdict = await args.evalHarness({
      content: streamingState.fullContent,
      actualToolCallCount: streamingState.lastToolCallCount,
      assistantMessageId: args.assistantId,
      finishReason: streamingState.lastFinishReason,
    });
    const harnessDirty = !!(verdict && !isClean(verdict));
    const nudgeNeeded =
      !harnessDirty &&
      !!args.tools &&
      streamingState.lastFinishReason === "stop" &&
      streamingState.lastToolCallCount === 0 &&
      (detectIntentNoToolCall(streamingState.fullContent) || args.turnImpliesWrite);

    const retryDecision = decideStreamRetry({
      pureMode: args.pureMode,
      harnessDirty,
      nudgeNeeded,
      attempt,
      maxRetry: MAX_HARNESS_RETRY,
      hasTools: !!args.tools,
      verdict,
    });
    if (retryDecision.shouldRetry) {
      args.setHarnessNotice(
        retryDecision.notice === "harness"
          ? args.labels.harnessRetry
          : args.labels.intentNudgeRetry,
      );
      forceToolChoiceRequired = retryDecision.forceToolChoice;
      convo = [
        ...convo,
        { role: "assistant" as const, content: streamingState.fullContent },
        { role: "user" as const, content: retryDecision.retryPrompt },
      ];
      continue;
    }

    if (harnessDirty) {
      args.setMessages((prev) =>
        prev.map((message) =>
          message.id === args.assistantId
            ? {
              ...message,
              harness: {
                unverifiedPaths: verdict!.unverifiedPaths,
                unverifiedUrls: verdict!.unverifiedUrls,
                unverifiedCommands: verdict!.unverifiedCommands,
                pseudoToolNames: verdict!.pseudoToolNames,
                fabricatedUsageCount: verdict!.fabricatedUsageCount ?? null,
                fabricationSuspected: verdict!.fabricationSuspected ?? null,
              },
            }
            : message,
        ),
      );
    }
    return { ...streamingState, aborted: false };
  }
}
