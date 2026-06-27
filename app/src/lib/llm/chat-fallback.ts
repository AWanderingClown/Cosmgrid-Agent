// 运行时回退链触发（v0.4.1 重构版）
// 把"主模型失败 → 自动切 fallback"逻辑抽出来，ChatPage 和 StageChat 共用。
//
// v0.4.1 重构：换成 models 数组支持 N 步 fallback 链、onSwitched 用 SwitchReason
// 类型（不再假报 rate_limit）、shouldFallback 决策从 ClassifiedLlmError 拿、
// 内置 recordUsageEvent 避免调用方写错 modelName/providerId、抽 toModelEndpoint
// builder 消除 4 处 provider.type guard。
//
// 设计决策：
// 1. 保留流式体验：主模型一开始流就报错（最常见的 401/429/网络问题）时才切 fallback 重发；
//    流到一半失败的场景留给 v0.4.x 优化（少见 + 难做）。
// 2. 哪些错误触发 fallback：401/403/404/429/超时/网络/5xx → 切；
//    context_overflow（413 / 上下文超长）→ 不切（换模型也救不了，让用户知道要压缩历史）；
//    unknown → 不切（保守，避免浪费 fallback 配额）。
// 3. cooldown 熔断：模型刚失败过就先跳过（见 model-cooldown.ts）。
// 4. onSwitched 用 SwitchReason（discriminated union）区分"出错切"和"cooldown 跳过"，
//    不再混用 LlmErrorCategory。
// 5. 链式调用：models 数组按顺序尝试，跳过 cooldown 的，遇到非 shouldFallback 的错就终止。

import { streamText, stepCountIs, type ToolSet, type ModelMessage } from "ai";
import { getLanguageModel } from "./provider-factory";
import { classifyLlmError, type LlmErrorCategory } from "./error-classifier";
import { isInCooldown, markModelFailed, markModelSucceeded } from "./model-cooldown";
import { recordUsageEvent, type RecordUsageParams } from "./usage-tracker";
import { isCliProviderType, type CliMessage } from "./cli-protocol";
import { streamViaCli } from "./cli-engine";
import { classifyMessageComplexity } from "./message-router";
import { detectDoomLoop, type StepToolCall } from "./harness/doom-loop";
import { resolveMaxOutputTokens, ensureModelLimitsLoaded } from "./model-limits";
import type { ChatMsg } from "./context-compressor";

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
  | { kind: "cooldown" };

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
  /**
   * 阶段4 Handoff：streamText 全部 step 跑完后，把累积的所有 toolCalls 一次交给 caller。
   * caller 用它判断模型是否调了 `handoff_to_X`（用于多 AI 协作接力）。
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

  let usedIndex = startIdx;
  while (usedIndex < models.length) {
    const target = models[usedIndex]!;

    if (options.signal?.aborted) {
      return { usedModelId: target.modelId, switched: usedIndex !== 0 };
    }

    try {
      let streamUsage: StreamUsage;
      let finishReason: string;
      let wasAborted: boolean;
      const startedAt = Date.now();

      if (isCliProviderType(target.providerType)) {
        // CLI 引擎路径：spawn 本机 claude/codex 吃订阅额度（baseUrl 复用为可执行文件路径）
        // CLI 不支持图片——带图消息的 chain 已在 ChatPage 过滤掉 CLI 端点；这里防御性把数组 content 折叠成纯文本
        const cliMessages: CliMessage[] = messages.map((m) => ({
          role: m.role as "user" | "assistant" | "system",
          content:
            typeof m.content === "string"
              ? m.content
              : m.content.filter((p) => p.type === "text").map((p) => ("text" in p ? p.text : "")).join(""),
        }));
        const cliResult = await streamViaCli(
          {
            providerType: target.providerType,
            modelName: target.modelName,
            ...(target.baseUrl ? { program: target.baseUrl } : {}),
          },
          cliMessages,
          { onDelta: callbacks.onDelta },
          options.signal ? { signal: options.signal } : {},
        );
        finishReason = cliResult.finishReason;
        wasAborted = finishReason === "abort" || (options.signal?.aborted ?? false);
        streamUsage = {
          inputTokens: cliResult.inputTokens,
          outputTokens: cliResult.outputTokens,
          toolCallCount: 0, // CLI 引擎本轮不计（spawn claude/codex 用它们自家的工具，不走我们 tool_calls）
        };
      } else {
        // API 直连路径：Vercel AI SDK streamText
        const lm = getLanguageModel(target.providerType, target.modelName, target.apiKey, target.baseUrl);
        // 阶段2：本地 abort 控制器——联动用户 signal，doom loop 命中时主动 abort 流
        const localAbort = new AbortController();
        const onParentAbort = () => localAbort.abort();
        options.signal?.addEventListener("abort", onParentAbort);
        // 阶段2：累计 toolCalls 供 doom loop 检测（连续 3 次相同工具调用 = 死循环，抄 OpenCode）
        const stepToolCalls: StepToolCall[] = [];
        const result = streamText({
          model: lm,
          messages: messages as unknown as ModelMessage[],
          // 按 models.dev 该模型真实输出上限给足预算（clamp 到模型能力、封顶 CEILING）——
          // 否则不传 max_tokens 时被供应商小默认值截断；传死大值又会让小上限模型被 400 拒
          maxOutputTokens: options.maxOutputTokens ?? resolveMaxOutputTokens(target.modelName),
          // 阶段2：API 调用失败自动重试（4 重防死循环之一）
          maxRetries: 3,
          // 传了 tools 才开工具调用 + 多步循环（stopWhen 防死循环）+ doom loop 检测
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
          callbacks.onDelta(delta);
        }

        // 阶段4 Handoff：把累积的 toolCalls 一次性交给 caller（不传=onFinalToolCalls 即 noop）
        callbacks.onFinalToolCalls?.(
          stepToolCalls.map((tc) => ({ toolName: tc.toolName, input: tc.input })),
        );

        const usage = await result.usage;
        finishReason = (await result.finishReason) ?? "stop";
        wasAborted = localAbort.signal.aborted || (options.signal?.aborted ?? false);
        streamUsage = {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          toolCallCount: stepToolCalls.length, // 阶段 H：本轮真调了几次工具
        };
        options.signal?.removeEventListener("abort", onParentAbort);
      }

      markModelSucceeded(target.modelId);
      callbacks.onUsage?.(streamUsage, target, finishReason, wasAborted);

      // 落 UsageEvent（chat-fallback 内置，避免调用方写错 modelName/providerId）
      // interrupted=true 的不写——abort 没收尾，统计意义不大
      if (!wasAborted) {
        const params: RecordUsageParams = {
          modelId: target.modelId,
          modelName: target.modelName,
          providerId: target.providerId,
          apiCredentialId: target.apiCredentialId,
          usage: { inputTokens: streamUsage.inputTokens, outputTokens: streamUsage.outputTokens },
          finishReason,
          interrupted: false,
          latencyMs: Date.now() - startedAt,
        };
        if (options.projectId) params.projectId = options.projectId;
        if (options.conversationId) params.conversationId = options.conversationId;
        // role 不传则按最后一条 user 消息推断难度桶（避免每个调用方各算一遍）
        params.role = options.role ?? inferRole(messages);
        // 阶段 F1：actor 维度透传（不设兜底，undefined → NULL；review F1-1 聚合不过滤 NULL）
        if (options.actorRole !== undefined) params.roleKind = options.actorRole;
        void recordUsageEvent(params);
      }

      return { usedModelId: target.modelId, switched: usedIndex !== 0 };
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError" || options.signal?.aborted) {
        return { usedModelId: target.modelId, switched: usedIndex !== 0 };
      }
      const classified = classifyLlmError(err);

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

      usedIndex++;
    }
  }

  // 理论上到不了（while 出口要么 return 要么 throw），TypeScript 需要兜底
  throw new Error("streamWithFallback: unknown state");
}
