// 运行时回退链触发（v0.4.1 重构版）
// 把"主模型失败 → 自动切 fallback"逻辑抽出来，ChatPage 和 StageChat 共用。
//
// v0.4.1 重构：换成 models 数组支持 N 步 fallback 链、onSwitched 用 SwitchReason
// 类型（不再假报 rate_limit）、shouldFallback 决策从 ClassifiedLlmError 拿、
// 内置 recordUsageEvent 避免调用方写错 modelName/providerId、抽 toModelEndpoint
// builder 消除 4 处 provider.type guard。
//
// 2026-07-09 二次重构（拆热点文件，719→约300行）：原来堆在一个文件里的类型定义
// （ModelEndpoint/StreamUsage/SwitchReason/StreamCallbacks/toModelEndpoint）拆到
// chat-fallback-types.ts；单模型单次调用的 CLI/API 双路径逻辑（原 runAttempt 嵌套
// 函数）拆到 chat-fallback-attempt.ts；纯辅助函数拆到 chat-fallback-recovery.ts。
// 本文件只保留 streamWithFallback 的 fallback 链编排主循环。所有类型/函数继续从本
// 文件 re-export，7 个既有消费者（chain-runner.ts/useChatStream.ts 等）的 import
// 路径和符号完全不变，零改动。
//
// 设计决策：
// 1. 保留流式体验：主模型失败时自动切 fallback；如果已经流出部分内容，
//    会把已输出片段放回上下文，要求下一个模型从中断处继续、不要重复。
// 2. 哪些错误触发 fallback：401/403/404/429/超时/网络/5xx → 切；
//    context_overflow（413 / 上下文超长）→ 不切（换模型也救不了，让用户知道要压缩历史）；
//    unknown → 不切（保守，避免浪费 fallback 配额）。
// 3. cooldown 熔断：模型刚失败过就先跳过（见 model-cooldown.ts）。
// 4. onSwitched 用 SwitchReason（discriminated union）区分"出错切"和"cooldown 跳过"，
//    不再混用 LlmErrorCategory。
// 5. 链式调用：models 数组按顺序尝试，跳过 cooldown 的，遇到非 shouldFallback 的错就终止。

import { classifyLlmError } from "./error-classifier";
import { hydrateModelCooldowns, isInCooldown, markModelFailed, markModelSucceeded, getCooldownRemainingMs } from "./model-cooldown";
import { recordUsageEvent, type RecordUsageParams } from "./usage-tracker";
import { runModelAttempt } from "./chat-fallback-attempt";
import { buildRecoveryMessages, getPartialTextFromError, inferRole } from "./chat-fallback-recovery";
import { buildLlmInvocationAuditEvent } from "./invocation-audit";
import { ensureModelLimitsLoaded } from "./model-limits";
import { isNormalFinishReason, isRecoverableTruncation } from "./finish-reason";
import type { StepToolCall } from "./harness/doom-loop";
import type { ChatMsg } from "./context-compressor";
import {
  toModelEndpoint,
  type ModelEndpoint,
  type StreamCallbacks,
  type StreamUsage,
  type StreamWithFallbackOptions,
  type SwitchReason,
} from "./chat-fallback-types";

export { toModelEndpoint };
export type { ModelEndpoint, StreamCallbacks, StreamUsage, StreamWithFallbackOptions, SwitchReason };

const MAX_AUTO_CONTINUATIONS = 2;

/**
 * 流式对话，按顺序尝试 models 中的每一个端点。
 * - 跳过在 cooldown 中的模型
 * - 出错时按错误分类决定是否尝试下一个：shouldFallback=true 才跳；否则抛错
 * - 中途 abort（AbortSignal）→ 不写 usage，标记 interrupted
 * - 自动写 UsageEvent（解决调用方把 fallback 调用错记成 primary 的 latent bug）
 *
 * @param models 按优先级排序的模型链（必须至少 1 个）。fallback 写在后面。
 * @returns 最后成功调用的 modelId；如果切过，switched=true
 */
export async function streamWithFallback(
  models: ModelEndpoint[],
  messages: ChatMsg[],
  callbacks: StreamCallbacks,
  options: StreamWithFallbackOptions = {},
): Promise<{ usedModelId: string; switched: boolean }> {
  if (models.length === 0) {
    throw new Error("streamWithFallback: models array cannot be empty");
  }

  // 预热 models.dev 输出上限表（幂等、不阻塞本轮）。首轮没拉到就用 CEILING 兜底，下轮起精确 clamp。
  void ensureModelLimitsLoaded();
  await hydrateModelCooldowns(models.map((m) => m.modelId)).catch(() => {});

  // 跳过 cooldown 中的模型：从前往后找第一个不在 cooldown 的；前面被跳过的都触发 onSwitched("cooldown")
  let startIdx = 0;
  while (startIdx < models.length && isInCooldown(models[startIdx]!.modelId)) {
    const skipped = models[startIdx]!;
    const skippedAt = Date.now();
    callbacks.onInvocationAudit?.(buildLlmInvocationAuditEvent({
      target: skipped,
      status: "cooldown",
      startedAtMs: skippedAt,
      endedAtMs: skippedAt,
      finishReason: "cooldown",
    }));
    if (startIdx < models.length - 1) {
      const next = models[startIdx + 1]!;
      callbacks.onSwitched?.(skipped, next, { kind: "cooldown" });
    }
    startIdx++;
  }
  if (startIdx >= models.length) {
    // 修复（2026-07-05）：之前这里直接抛裸英文 Error，classifyLlmError 认不出来只能落进
    // "unknown"兜底——用户只看到一句生硬的英文提示，不知道具体是哪几个模型在冷却、还要
    // 等多久，也不知道重启 app 能立即清空（冷却状态只在内存里，见 model-cooldown.ts）。
    // 这里把每个模型的剩余冷却时间拼进消息，error-classifier.ts 按前缀识别后原样透出。
    const detail = models
      .map((m) => {
        const mins = Math.max(1, Math.ceil(getCooldownRemainingMs(m.modelId) / 60_000));
        return `${m.displayLabel ?? m.modelName}（还需 ${mins} 分钟）`;
      })
      .join("、");
    throw new Error(`All models are cooling down: ${detail}`);
  }

  function recordUsageEventOnly(args: {
    target: ModelEndpoint;
    usage: StreamUsage;
    finishReason: string;
    startedAt: number;
  }): void {
    const params: RecordUsageParams = {
      modelId: args.target.modelId,
      modelName: args.target.modelName,
      providerType: args.target.providerType,
      providerId: args.target.providerId,
      apiCredentialId: args.target.apiCredentialId,
      usage: {
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        cacheReadInputTokens: args.usage.cacheReadInputTokens,
        cacheWriteInputTokens: args.usage.cacheWriteInputTokens,
      },
      finishReason: args.finishReason,
      interrupted: false,
      latencyMs: Date.now() - args.startedAt,
    };
    if (options.projectId) params.projectId = options.projectId;
    if (options.conversationId) params.conversationId = options.conversationId;
    params.role = options.role ?? inferRole(messages);
    if (options.actorRole !== undefined) params.roleKind = options.actorRole;
    if (options.routingDecision) params.routingDecision = options.routingDecision;
    if (options.compressionStats) params.compressionStats = options.compressionStats;
    void recordUsageEvent(params);
  }

  function recordFinalUsage(args: {
    target: ModelEndpoint;
    usage: StreamUsage;
    finishReason: string;
    startedAt: number;
  }): void {
    callbacks.onUsage?.(args.usage, args.target, args.finishReason, false);
    recordUsageEventOnly(args);
  }

  let usedIndex = startIdx;
  let activeMessages = messages;
  let aggregateUsage: StreamUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    toolCallCount: 0,
  };
  let aggregateToolCalls: StepToolCall[] = [];

  while (usedIndex < models.length) {
    const target = models[usedIndex]!;
    const modelStartedAt = Date.now();

    if (options.signal?.aborted) {
      return { usedModelId: target.modelId, switched: usedIndex !== 0 };
    }

    let continuationsForThisModel = 0;
    while (true) {
      try {
        const attempt = await runModelAttempt(target, activeMessages, callbacks, options);
        aggregateUsage.inputTokens += attempt.streamUsage.inputTokens;
        aggregateUsage.outputTokens += attempt.streamUsage.outputTokens;
        aggregateUsage.cacheReadInputTokens =
          (aggregateUsage.cacheReadInputTokens ?? 0) + (attempt.streamUsage.cacheReadInputTokens ?? 0);
        aggregateUsage.cacheWriteInputTokens =
          (aggregateUsage.cacheWriteInputTokens ?? 0) + (attempt.streamUsage.cacheWriteInputTokens ?? 0);
        aggregateUsage.toolCallCount += attempt.streamUsage.toolCallCount;
        aggregateToolCalls.push(...attempt.toolCalls);

        if (attempt.wasAborted) {
          callbacks.onInvocationAudit?.(buildLlmInvocationAuditEvent({
            target,
            status: "aborted",
            startedAtMs: modelStartedAt,
            finishReason: attempt.finishReason,
            usage: aggregateUsage,
          }));
          return { usedModelId: target.modelId, switched: usedIndex !== 0 };
        }

        if (!isNormalFinishReason(attempt.finishReason) &&
          isRecoverableTruncation(attempt.finishReason)) {
          if (continuationsForThisModel < MAX_AUTO_CONTINUATIONS) {
            callbacks.onRecovered?.("context_replay");
            activeMessages = buildRecoveryMessages(activeMessages, attempt.partialText, attempt.finishReason);
            continuationsForThisModel++;
            continue;
          }

          markModelFailed(target.modelId);
          recordUsageEventOnly({
            target,
            usage: aggregateUsage,
            finishReason: attempt.finishReason,
            startedAt: modelStartedAt,
          });
          if (usedIndex >= models.length - 1) {
            throw new Error(`Model output was truncated after ${MAX_AUTO_CONTINUATIONS} automatic continuations`);
          }
          const next = models[usedIndex + 1]!;
          callbacks.onSwitched?.(target, next, { kind: "recovery", reason: attempt.finishReason });
          callbacks.onRecovered?.("fallback_handoff");
          activeMessages = buildRecoveryMessages(activeMessages, attempt.partialText, attempt.finishReason);
          aggregateUsage = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            toolCallCount: 0,
          };
          aggregateToolCalls = [];
          usedIndex++;
          break;
        }

        if (!isNormalFinishReason(attempt.finishReason)) {
          markModelFailed(target.modelId);
          recordUsageEventOnly({
            target,
            usage: aggregateUsage,
            finishReason: attempt.finishReason,
            startedAt: modelStartedAt,
          });
          if (usedIndex >= models.length - 1) {
            throw new Error(`Model call ended abnormally: ${attempt.finishReason}`);
          }
          const next = models[usedIndex + 1]!;
          callbacks.onSwitched?.(target, next, { kind: "recovery", reason: attempt.finishReason });
          callbacks.onRecovered?.("fallback_handoff");
          activeMessages = buildRecoveryMessages(activeMessages, attempt.partialText, attempt.finishReason);
          aggregateUsage = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            toolCallCount: 0,
          };
          aggregateToolCalls = [];
          usedIndex++;
          break;
        }

        markModelSucceeded(target.modelId);
        callbacks.onInvocationAudit?.(buildLlmInvocationAuditEvent({
          target,
          status: "success",
          startedAtMs: modelStartedAt,
          finishReason: attempt.finishReason,
          usage: aggregateUsage,
        }));
        callbacks.onFinalToolCalls?.(
          aggregateToolCalls.map((tc) => ({ toolName: tc.toolName, input: tc.input })),
        );
        recordFinalUsage({
          target,
          usage: aggregateUsage,
          finishReason: attempt.finishReason,
          startedAt: modelStartedAt,
        });
        return { usedModelId: target.modelId, switched: usedIndex !== 0 };
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError" || options.signal?.aborted) {
          return { usedModelId: target.modelId, switched: usedIndex !== 0 };
        }
        // 1.2 修复：传 providerType 让 classifyLlmError 按国产 provider 专属规则匹配（中文错误体）
        const classified = classifyLlmError(err, undefined, target.providerType);
        callbacks.onInvocationAudit?.(buildLlmInvocationAuditEvent({
          target,
          status: "error",
          startedAtMs: modelStartedAt,
          finishReason: classified.category,
          errorCategory: classified.category,
          usage: aggregateUsage,
        }));

        recordUsageEventOnly({
          target,
          usage: aggregateUsage,
          finishReason: classified.category,
          startedAt: modelStartedAt,
        });

        // 是否尝试下一个模型？
        if (!classified.shouldFallback || usedIndex >= models.length - 1) {
          // 不可恢复 或 已是最后一个：标 failed，抛错
          markModelFailed(target.modelId);
          throw err;
        }

        // 标记 failed（确认要切才标，避免不该切的也进 cooldown）
        markModelFailed(target.modelId);

        // 触发 onSwitched（cooldown 跳过的已经在上面触发过）
        const next = models[usedIndex + 1]!;
        callbacks.onSwitched?.(target, next, { kind: "error", category: classified.category });
        callbacks.onRecovered?.("fallback_handoff");
        const partialText = getPartialTextFromError(err);
        if (partialText.trim()) {
          activeMessages = buildRecoveryMessages(activeMessages, partialText, classified.category);
        }

        aggregateUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          toolCallCount: 0,
        };
        aggregateToolCalls = [];
        usedIndex++;
        break;
      }
    }
  }

  // 理论上到不了（while 出口要么 return 要么 throw），TypeScript 需要兜底
  throw new Error("streamWithFallback: unknown state");
}
