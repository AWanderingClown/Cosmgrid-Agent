// chat-fallback 的单模型单次调用逻辑（CLI/API 双路径），从 chat-fallback.ts 的
// streamWithFallback 内部嵌套函数 runAttempt 拆出（2026-07-09）。这是原文件里最大、
// 也最自成一体的一块——它只负责"对着一个 ModelEndpoint 跑一次"，完全不碰外层 fallback
// 循环的聚合状态（models 数组遍历、usedIndex、aggregateUsage 等），提出来对行为零影响，
// 只是把闭包捕获的 callbacks/options 改成显式参数。

import { streamText, stepCountIs, type ModelMessage } from "ai";
import { cliSessions } from "../db";
import { getLanguageModel } from "./provider-factory";
import { classifyLlmError } from "./error-classifier";
import { isCliProviderType, type CliMessage } from "./cli-protocol";
import { streamViaCli } from "./cli-engine";
import { detectDoomLoop, type StepToolCall } from "./harness/doom-loop";
import { resolveMaxOutputTokens } from "./model-limits";
import { isNormalFinishReason, isRecoverableTruncation } from "./finish-reason";
import type { ChatMsg } from "./context-compressor";
import type { ModelEndpoint, StreamCallbacks, StreamUsage, StreamWithFallbackOptions } from "./chat-fallback-types";

/** 单次模型调用需要用到的回调子集——onSwitched/onUsage/onFinalToolCalls/onInvocationAudit
 *  属于外层 fallback 循环的编排结果，不该也不会被单次 attempt 触发。 */
type AttemptCallbacks = Pick<StreamCallbacks, "onDelta" | "onStatus" | "onResolvedModel" | "onRecovered">;

export interface ModelAttemptResult {
  streamUsage: StreamUsage;
  finishReason: string;
  wasAborted: boolean;
  partialText: string;
  toolCalls: StepToolCall[];
}

/**
 * 对着一个 ModelEndpoint 跑一次调用（CLI 或 API，按 target.providerType 分流）。
 * - CLI 路径：spawn 本机 claude/codex，遇到可恢复截断会原生 resume 一次
 * - API 路径：Vercel AI SDK streamText，多步 agentic 工具调用 + doom-loop 检测
 */
export async function runModelAttempt(
  target: ModelEndpoint,
  attemptMessages: ChatMsg[],
  callbacks: AttemptCallbacks,
  options: StreamWithFallbackOptions,
  // 同一模型跨续接批次累积的工具调用历史，只用于 doom-loop 判定（不计入本次返回的
  // toolCalls/streamUsage，避免外层 aggregateUsage 重复计数）。不传时默认空数组，
  // doom-loop 退化成"仅本批内检测"，跟改造前行为一致。
  priorToolCalls: StepToolCall[] = [],
): Promise<ModelAttemptResult> {
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
      actualModelName: string | null;
    }> => {
      const cliResult = await streamViaCli(
        {
          providerType: target.providerType as "claude-cli" | "codex-cli",
          modelName: target.modelName,
          ...(target.baseUrl ? { program: target.baseUrl } : {}),
          ...(target.workingDirectory ? { workingDirectory: target.workingDirectory } : {}),
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
          onStatus: callbacks.onStatus,
          onModel: (modelName) => callbacks.onResolvedModel?.(modelName, target),
        },
        {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.cliAccess ? { access: options.cliAccess } : {}),
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
        actualModelName: cliResult.actualModelName,
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
      // 修复（2026-07-07，用户实测发现）：原来这个 error 只用来取 sessionId，从没打印过就
      // 直接丢了——如果紧接着的 resume 重试成功，原始失败原因永远无法追溯；如果 resume
      // 也失败，resume 自己的失败原因还会在下面的空 catch 里被再丢一次，最终往上抛的是
      // 第一次的 error，两次真实失败原因全部沉默消失，devtools 里连个痕迹都没有。
      console.error("[cli-engine] 首次调用失败，尝试 native resume", error);
      const firstErrorDetail = classifyLlmError(error).technicalMessage || undefined;
      const sessionId =
        (error as { officialSessionId?: string | null })?.officialSessionId ?? officialSessionId;
      if (sessionId && !(options.signal?.aborted ?? false)) {
        try {
          callbacks.onRecovered?.("native_resume", firstErrorDetail);
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
        } catch (resumeError) {
          console.error("[cli-engine] native resume 重试也失败", resumeError);
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
        toolChoice: options.toolChoice ?? "auto",
        stopWhen: stepCountIs(options.maxToolSteps ?? 20),
        onStepFinish: (event) => {
          const calls = (event.toolCalls ?? []) as { toolName: string; input: unknown }[];
          for (const tc of calls) {
            stepToolCalls.push({ toolName: tc.toolName, input: tc.input });
          }
          // 修复（doom-loop 跨批失明）：stepToolCalls 只是本批（单次 runModelAttempt）内的
          // 调用记录，撞 stepCountIs 上限续接后会重新调用 runModelAttempt、本地数组清零重来
          // ——原来的写法会让 doom-loop 只在单批 12 步以内生效，续接之后完全失去空转检测能力。
          // 拼上调用方传入的跨批历史，让判定覆盖整个模型调用链，不受续接边界影响。
          if (detectDoomLoop([...priorToolCalls, ...stepToolCalls])) localAbort.abort();
        },
      } : {}),
      abortSignal: localAbort.signal,
    });

    // C 档第2步（2026-07-12）：改读 fullStream 而不是只读 textStream。
    // 关键发现：AI SDK 的 textStream getter 只过滤 part.type==="text-delta"
    // （node_modules/ai/dist/index.mjs:8102-8114），reasoning-delta 会被直接丢弃——
    // 对走结构化 reasoning 通道的 provider（如 DeepSeek 的 reasoning_content 映射），
    // 旧代码不是"思考没显示"，是思考内容彻底丢失、完全不落 partialText，
    // response-completeness.ts 的完整性判定也看不到它。
    // 这里把 reasoning-delta 重新包一层 <think> 标签喂给 onDelta，跟现有
    // parse-thinking.ts 的折叠渲染、response-completeness.ts 的可见正文判定无缝衔接，
    // 不用改 UI 渲染层或消息持久化层。MiniMax-M3 这类把 <think> 内联在纯文本里发的
    // 模型走的仍是 text-delta，不受影响（标签已经在文本里，原样透传）。
    let reasoningOpen = false;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        let chunk = part.text;
        if (reasoningOpen) {
          // 防御性收尾：正常情况下 provider 会先发 reasoning-end 再发 text-delta，
          // 这里兜底万一 provider 没规规矩矩发 reasoning-end 就直接开始吐正文。
          chunk = `</think>${chunk}`;
          reasoningOpen = false;
        }
        partialText += chunk;
        callbacks.onDelta(chunk);
      } else if (part.type === "reasoning-delta") {
        if (!part.text) continue; // 部分 provider 会吐空字符串占位，不产出可见内容
        const chunk = reasoningOpen ? part.text : `<think>${part.text}`;
        reasoningOpen = true;
        partialText += chunk;
        callbacks.onDelta(chunk);
      } else if (part.type === "reasoning-end") {
        if (reasoningOpen) {
          partialText += "</think>";
          callbacks.onDelta("</think>");
          reasoningOpen = false;
        }
      } else if (part.type === "error") {
        // fullStream 用专门的 "error" part 传递流内错误（不像 textStream 那样直接让
        // for-await 抛异常）——原样 throw，交给下面既有的 catch 分支处理，
        // 保持 classifyLlmError/__partialText 兜底逻辑完全不变。
        throw part.error;
      }
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
