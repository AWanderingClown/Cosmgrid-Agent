import type { Dispatch, SetStateAction } from "react";
import type { RoleId } from "@/lib/llm/orchestrator";
import {
  streamWithFallback,
  type ModelEndpoint,
  type StreamUsage,
  type StreamWithFallbackOptions,
} from "@/lib/llm/chat-fallback";
import { buildQuotaGuardFromAggregates } from "@/lib/llm/quota-guard";
import { tokenPlans } from "@/lib/db/token-plans";
import { usageEvents } from "@/lib/db/usage-events";
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
import type { StreamActivityPhase } from "@/pages/chat/streaming-status";

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
  setStreamActivityPhase?: Dispatch<SetStateAction<StreamActivityPhase>>;
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

  // D4：额度熔断守卫——额度耗尽的模型在 streamWithFallback 入口被跳过，让后备模型续跑；
  // 所有模型额度都耗尽则直接报错（与 cooldown 分开）。DB 不可用（CLI/测试）时静默回退
  // 到不熔断，保持原有行为。
  //
  // 2026-07-15 review 修复：这里每次发消息都要跑一遍，原来走 usageEvents.list() 把
  // usage_events 全表原始记录拉进 JS 再 reduce，历史越多越卡。改用 SQL 侧
  // GROUP BY (provider_id, api_credential_id) 聚合（aggregateByProviderCredential +
  // buildQuotaGuardFromAggregates），返回的行数只跟"用过几种 provider+credential 组合"
  // 成正比，跟 usage_events 总行数无关。
  let quotaGuard: StreamWithFallbackOptions["quotaGuard"];
  try {
    const [plans, aggregates] = await Promise.all([
      tokenPlans.list(),
      usageEvents.aggregateByProviderCredential(),
    ]);
    quotaGuard = await buildQuotaGuardFromAggregates(args.chain, plans, aggregates);
  } catch {
    quotaGuard = undefined;
  }

  for (let attempt = 0; ; attempt++) {
    args.setStreamActivityPhase?.("streaming");
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
            maxToolSteps: 20,
            ...(forceToolChoiceRequired ? { toolChoice: "required" as const } : {}),
          }
          : {}),
        ...(quotaGuard ? { quotaGuard } : {}),
      },
    );
    streamingState.lastResultModelId = result.usedModelId;
    if (args.controller.signal.aborted) {
      return { ...streamingState, aborted: true };
    }

    const verdict = args.pureMode
      ? null
      : await (async () => {
        args.setStreamActivityPhase?.("checking");
        return args.evalHarness({
          content: streamingState.fullContent,
          actualToolCallCount: streamingState.lastToolCallCount,
          assistantMessageId: args.assistantId,
          finishReason: streamingState.lastFinishReason,
        });
      })();
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
    // Harness 工程实施计划阶段1：重试耗尽后仍脏，才把最终结论交给节点验收门控——
    // 重试循环内部的中间态不算数，只有这里（真正 return 前）才是这一轮的最终判定。
    streamingState.harnessDirty = harnessDirty;
    return { ...streamingState, aborted: false };
  }
}
