// 运行时回退链触发（v0.4.1 重构版）
// 把"主模型失败 → 自动切 fallback"逻辑抽出来，ChatPage 和 StageChat 共用。
//
// v0.4.1 重构：换成 models 数组支持 N 步 fallback 链、onSwitched 用 SwitchReason
// 类型（不再假报 rate_limit）、shouldFallback 决策从 ClassifiedLlmError 拿、
// 内置 recordUsageEvent 避免调用方写错 modelName/providerId、抽 toModelEndpoint
// builder 消除 4 处 provider.type guard。
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

import { streamText, stepCountIs, type ToolSet, type ModelMessage } from "ai";
import { cliSessions } from "../db";
import { getLanguageModel } from "./provider-factory";
import { classifyLlmError, type LlmErrorCategory } from "./error-classifier";
import { isInCooldown, markModelFailed, markModelSucceeded } from "./model-cooldown";
import { recordUsageEvent, type RecordUsageParams } from "./usage-tracker";
import { isCliProviderType, type CliMessage } from "./cli-protocol";
import { streamViaCli } from "./cli-engine";
import { classifyMessageComplexity } from "./message-router";
import { detectDoomLoop, type StepToolCall } from "./harness/doom-loop";
import { resolveMaxOutputTokens, ensureModelLimitsLoaded } from "./model-limits";
import { isNormalFinishReason, isRecoverableTruncation } from "./finish-reason";
import type { ChatMsg } from "./context-compressor";

const MAX_AUTO_CONTINUATIONS = 2;

function buildRecoveryMessages(messages: ChatMsg[], partialText: string, reason: string): ChatMsg[] {
  const trimmed = partialText.trim();
  const recovered: ChatMsg[] = [...messages];
  if (trimmed) {
    recovered.push({ role: "assistant", content: trimmed });
  }
  recovered.push({
    role: "user",
    content:
      `上一次模型调用因为「${reason}」没有正常完成。请从刚才中断处继续，不要重复已经完成的内容，` +
      "继续完成用户原始任务。如果前文已经给出部分答案，只补剩余部分。",
  });
  return recovered;
}

function getPartialTextFromError(error: unknown): string {
  if (typeof error === "object" && error !== null && "__partialText" in error) {
    const partial = (error as { __partialText?: unknown }).__partialText;
    return typeof partial === "string" ? partial : "";
  }
  return "";
}

/** 从对话里取最后一条 user 消息推断难度桶（role 默认值）。兼容多模态 content（数组取 text part）。 */
function inferRole(messages: ChatMsg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      const c = m.content;
      const text =
        typeof c === "string"
          ? c
          : c.filter((p) => p.type === "text").map((p) => ("text" in p ? p.text : "")).join("");
      return classifyMessageComplexity(text);
    }
  }
  return "main_chat";
}

/** 一个可调用的模型端点：模型 + 凭证 + baseUrl */
export interface ModelEndpoint {
  /** DB 里 Model 表的 id（用于 cooldown 跟踪 + UsageEvent 关联） */
  modelId: string;
  /** 给 LLM 用的模型名（如 "claude-opus-4-8"） */
  modelName: string;
  /** "anthropic" / "openai" / "google" / "openai-compatible" */
  providerType: string;
  apiKey: string;
  baseUrl?: string;
  /** 给 UI 显示的标签（如 "Opus 4.8"），仅做展示 */
  displayLabel?: string;
  /** 对应 ApiCredential 的 id（用于 recordUsageEvent 落库关联） */
  apiCredentialId: string;
  /** 对应 Provider 的 id（用于 recordUsageEvent 落库关联） */
  providerId: string;
}

/** 给 UI 流的文本增量 */
export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** 阶段 H：本轮真实工具调用次数（来自 stepToolCalls.length）。
   *  - 0 + finishReason="stop" + 输出含动手意图 → Harness nudge 重答触发条件之一
   *  - 加这个字段让 ChatPage 在 onUsage 回调里直接拿到，不用额外暴露 streamText 内部状态 */
  toolCallCount: number;
}

/**
 * 切模型的原因（discriminated union）
 * - kind="error"：主模型真出错（带 LlmErrorCategory 分类）
 * - kind="cooldown"：主模型在 cooldown 中熔断，UI 提示"X 秒后可重试"
 * 不再用 LlmErrorCategory 一把抓，避免 cooldown 被假报成 rate_limit。
 */
export type SwitchReason =
  | { kind: "error"; category: LlmErrorCategory }
  | { kind: "cooldown" }
  | { kind: "recovery"; reason: string };

/** 流式过程的回调钩子 */
export interface StreamCallbacks {
  /** 每收到一段文本增量时触发（流式输出靠这个） */
  onDelta: (delta: string) => void;
  /**
   * 切换到下一个模型时触发（仅切的时候调一次，不切不调）。
   * 第一次进入时也会调：如果 models[0] 在 cooldown 中直接跳到 models[1]，会先调一次。
   */
  onSwitched?: (from: ModelEndpoint, to: ModelEndpoint, reason: SwitchReason) => void;
  /**
   * 整段对话成功结束时触发，UI 拿这个落 UsageEvent（chat-fallback 已自动调过 recordUsageEvent，
   * 这里给 UI 用于刷新"上次调用消耗"显示 + 自定义逻辑）。
   * interrupted=true 表示用户主动 abort（不写 usage，标记 interrupted）。
   */
  onUsage?: (usage: StreamUsage, model: ModelEndpoint, finishReason: string, interrupted: boolean) => void;
  /** 系统自动恢复的方式：原生续跑 / 上下文重放 / fallback 接力 */
  onRecovered?: (mode: "native_resume" | "context_replay" | "fallback_handoff") => void;
  /**
   * streamText 全部 step 跑完后，把累积的所有 toolCalls 一次交给 caller。
   * 不传=noop，零侵入。Abort 中断时不调。
   */
  onFinalToolCalls?: (toolCalls: { toolName: string; input?: unknown }[]) => void;
}

/**
 * 从 DB 形态 + 凭证 + apiKey 构造 ModelEndpoint。
 * 把"模型缺 provider 类型"的检查集中到一处——原来 4 个调用点都重复做这个 guard。
 */
export function toModelEndpoint(
  model: {
    id: string;
    name: string;
    displayName: string | null;
    providerId: string;
    provider?: { type: string } | null;
  },
  credential: { id: string; baseUrl: string },
  apiKey: string,
): ModelEndpoint {
  const providerType = model.provider?.type;
  if (!providerType) {
    throw new Error("Model missing provider type — re-add the provider");
  }
  return {
    modelId: model.id,
    modelName: model.name,
    providerType,
    providerId: model.providerId,
    apiCredentialId: credential.id,
    apiKey,
    baseUrl: credential.baseUrl,
    displayLabel: model.displayName ?? model.name,
  };
}

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
  options: {
    signal?: AbortSignal;
    /** 关联 projectId（用于 UsageEvent 落库），自由对话不传 */
    projectId?: string;
    /** 关联 conversationId（目前未使用，预留给未来按 conversation 聚合统计） */
    conversationId?: string;
    /** 消息难度桶（simple/standard/hard），落 UsageEvent 供 v0.9 SmartRouter 滚动统计。
     *  不传则内部按最后一条 user 消息推断（调用方无需各自重复算）。 */
    role?: string;
    /** 阶段 F1：actor 维度（leader/architect/frontend/.../stage）。
     *  - 跟 role（workRole 难度桶）配对清晰，不撞名
     *  - 不传 → NULL（review F1-1：leader 占比 80%+，NULL 是真实数据，聚合不过滤）
     *  - 调用方责任：必须显式传（ChatPage 主对话 → 'leader'，ProjectDetailPage → 'stage'，runChain 每跳 → role: RoleId） */
    actorRole?: string | null;
    /** v0.7 阶段4：工具集（read/glob/grep 等）。传了才开启工具调用 + 多步 agentic 循环 */
    tools?: ToolSet;
    /** 工具调用最大步数（防死循环），默认 8 */
    maxToolSteps?: number;
    /** 单次回答的最大输出 token。不传则用 DEFAULT_MAX_OUTPUT_TOKENS。
     *  关键：很多 OpenAI 兼容端点（MiniMax 等）不传 max_tokens 时默认值很小，
     *  推理型模型会把预算花在 <think> 上、正文没写完就被截断 → 必须显式给足。 */
    maxOutputTokens?: number;
    routingDecision?: {
      baselineModelId: string;
      baselineModelName: string;
      actualModelId: string;
    } | null;
    compressionStats?: {
      beforeTokens: number;
      afterTokens: number;
    } | null;
  } = {},
): Promise<{ usedModelId: string; switched: boolean }> {
  if (models.length === 0) {
    throw new Error("streamWithFallback: models array cannot be empty");
  }

  // 预热 models.dev 输出上限表（幂等、不阻塞本轮）。首轮没拉到就用 CEILING 兜底，下轮起精确 clamp。
  void ensureModelLimitsLoaded();

  // 跳过 cooldown 中的模型：从前往后找第一个不在 cooldown 的；前面被跳过的都触发 onSwitched("cooldown")
  let startIdx = 0;
  while (startIdx < models.length && isInCooldown(models[startIdx]!.modelId)) {
    if (startIdx < models.length - 1) {
      const next = models[startIdx + 1]!;
      callbacks.onSwitched?.(models[startIdx]!, next, { kind: "cooldown" });
    }
    startIdx++;
  }
  if (startIdx >= models.length) {
    throw new Error("All models are cooling down — please try again later");
  }

  async function runAttempt(
    target: ModelEndpoint,
    attemptMessages: ChatMsg[],
  ): Promise<{
    streamUsage: StreamUsage;
    finishReason: string;
    wasAborted: boolean;
    partialText: string;
    toolCalls: StepToolCall[];
  }> {
    let partialText = "";

    if (isCliProviderType(target.providerType)) {
      // CLI 引擎路径：spawn 本机 claude/codex 吃订阅额度（baseUrl 复用为可执行文件路径）
      // CLI 不支持图片——带图消息的 chain 已在 ChatPage 过滤掉 CLI 端点；这里防御性把数组 content 折叠成纯文本
      const cliMessages: CliMessage[] = attemptMessages.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content:
          typeof m.content === "string"
            ? m.content
            : m.content.filter((p) => p.type === "text").map((p) => ("text" in p ? p.text : "")).join(""),
      }));
      let officialSessionId: string | null = null;
      const persistCliSession = (sessionId: string, status: "active" | "completed" | "failed") => {
        void cliSessions.upsert({
          providerType: target.providerType as "claude-cli" | "codex-cli",
          conversationId: options.conversationId ?? null,
          projectId: options.projectId ?? null,
          officialSessionId: sessionId,
          modelName: target.modelName,
          program: target.baseUrl ?? null,
          status,
        }).catch(() => {});
      };
      const runCli = async (
        resumeSessionId?: string | null,
      ): Promise<{
        finishReason: string;
        wasAborted: boolean;
        inputTokens: number;
        outputTokens: number;
        officialSessionId: string | null;
      }> => {
        const cliResult = await streamViaCli(
          {
            providerType: target.providerType as "claude-cli" | "codex-cli",
            modelName: target.modelName,
            ...(target.baseUrl ? { program: target.baseUrl } : {}),
          },
          cliMessages,
          {
            onDelta: (delta) => {
              partialText += delta;
              callbacks.onDelta(delta);
            },
            onSession: (sessionId) => {
              officialSessionId = sessionId;
              persistCliSession(sessionId, "active");
            },
          },
          {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(resumeSessionId
              ? {
                  resumeSessionId,
                  resumePrompt: "Continue from where you stopped. Do not repeat completed content.",
                }
              : {}),
          },
        );
        if (cliResult.officialSessionId) {
          officialSessionId = cliResult.officialSessionId;
        }
        return {
          finishReason: cliResult.finishReason,
          wasAborted: cliResult.finishReason === "abort" || (options.signal?.aborted ?? false),
          inputTokens: cliResult.inputTokens,
          outputTokens: cliResult.outputTokens,
          officialSessionId,
        };
      };
      try {
        const cliResult = await runCli();
        let totalInputTokens = cliResult.inputTokens;
        let totalOutputTokens = cliResult.outputTokens;
        let finishReason = cliResult.finishReason;
        let wasAborted = cliResult.wasAborted;
        if (
          !wasAborted &&
          officialSessionId &&
          isRecoverableTruncation(finishReason)
        ) {
          callbacks.onRecovered?.("native_resume");
          const resumed = await runCli(officialSessionId);
          totalInputTokens += resumed.inputTokens;
          totalOutputTokens += resumed.outputTokens;
          finishReason = resumed.finishReason;
          wasAborted = resumed.wasAborted;
        }
        if (officialSessionId) {
          persistCliSession(officialSessionId, isNormalFinishReason(finishReason) ? "completed" : "failed");
        }
        return {
          finishReason,
          wasAborted,
          partialText,
          toolCalls: [],
          streamUsage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            toolCallCount: 0,
          },
        };
      } catch (error) {
        const sessionId =
          (error as { officialSessionId?: string | null })?.officialSessionId ?? officialSessionId;
        if (sessionId && !(options.signal?.aborted ?? false)) {
          try {
            callbacks.onRecovered?.("native_resume");
            const resumed = await runCli(sessionId);
            persistCliSession(sessionId, isNormalFinishReason(resumed.finishReason) ? "completed" : "failed");
            return {
              finishReason: resumed.finishReason,
              wasAborted: resumed.wasAborted,
              partialText,
              toolCalls: [],
              streamUsage: {
                inputTokens: resumed.inputTokens,
                outputTokens: resumed.outputTokens,
                toolCallCount: 0,
              },
            };
          } catch {
            persistCliSession(sessionId, "failed");
          }
        }
        if (typeof error === "object" && error !== null) {
          (error as { __partialText?: string }).__partialText = partialText;
        }
        throw error;
      }
    }

    // API 直连路径：Vercel AI SDK streamText
    const lm = getLanguageModel(target.providerType, target.modelName, target.apiKey, target.baseUrl);
    const localAbort = new AbortController();
    const onParentAbort = () => localAbort.abort();
    options.signal?.addEventListener("abort", onParentAbort);
    const stepToolCalls: StepToolCall[] = [];

    try {
      const result = streamText({
        model: lm,
        messages: attemptMessages as unknown as ModelMessage[],
        maxOutputTokens: options.maxOutputTokens ?? resolveMaxOutputTokens(target.modelName),
        maxRetries: 3,
        ...(options.tools ? {
          tools: options.tools,
          stopWhen: stepCountIs(options.maxToolSteps ?? 8),
          onStepFinish: (event) => {
            const calls = (event.toolCalls ?? []) as { toolName: string; input: unknown }[];
            for (const tc of calls) {
              stepToolCalls.push({ toolName: tc.toolName, input: tc.input });
            }
            if (detectDoomLoop(stepToolCalls)) localAbort.abort();
          },
        } : {}),
        abortSignal: localAbort.signal,
      });

      for await (const delta of result.textStream) {
        partialText += delta;
        callbacks.onDelta(delta);
      }

      const usage = await result.usage;
      const finishReason = (await result.finishReason) ?? "stop";
      return {
        finishReason,
        wasAborted: localAbort.signal.aborted || (options.signal?.aborted ?? false),
        partialText,
        toolCalls: stepToolCalls,
        streamUsage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheReadInputTokens:
            usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0,
          cacheWriteInputTokens:
            usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
          toolCallCount: stepToolCalls.length,
        },
      };
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        (error as { __partialText?: string }).__partialText = partialText;
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onParentAbort);
    }
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
        const attempt = await runAttempt(target, activeMessages);
        aggregateUsage.inputTokens += attempt.streamUsage.inputTokens;
        aggregateUsage.outputTokens += attempt.streamUsage.outputTokens;
        aggregateUsage.cacheReadInputTokens =
          (aggregateUsage.cacheReadInputTokens ?? 0) + (attempt.streamUsage.cacheReadInputTokens ?? 0);
        aggregateUsage.cacheWriteInputTokens =
          (aggregateUsage.cacheWriteInputTokens ?? 0) + (attempt.streamUsage.cacheWriteInputTokens ?? 0);
        aggregateUsage.toolCallCount += attempt.streamUsage.toolCallCount;
        aggregateToolCalls.push(...attempt.toolCalls);

        if (attempt.wasAborted) {
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
        const classified = classifyLlmError(err);

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
