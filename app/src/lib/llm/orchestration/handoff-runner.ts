// 阶段4 — Handoff runStep 实现（E2 完整版）
//
// 职责：
// 1. 把 ExpertAgent 转成 ModelEndpoint（需要 availableModels + credentials + getApiKey）
// 2. 调 streamWithFallback 跑目标 agent
// 3. 收集 onFinalToolCalls（handoff 引擎检测决策需要）
// 4. 返回 { content, toolCalls } 给 runHandoffWorkflow
//
// 设计：
// - 接收 ctx（ChatPage 传，包含 availableModels/credentials/getApiKey/signal/callbacks）
// - 失败抛错 → runHandoffWorkflow 内部 try/catch → result.error 填 → 不炸主对话
// - 流式回调（onDelta/onSwitched）通过 ctx.onDelta 转发给 ChatPage，让 UI 显示

import { toModelEndpoint, streamWithFallback } from "../chat-fallback";
import type { ModelListItem, CredentialListItem } from "@/lib/api";
import type { ExpertAgent } from "./handoff";

/** ChatPage 提供的 ctx（避开 React state 直接依赖） */
export interface HandoffRunnerContext {
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  getApiKey: (credentialId: string) => Promise<string | null>;
  signal?: AbortSignal;
  /** 流式增量（每收到一段文本） */
  onDelta?: (delta: string) => void;
  /** 切换模型时 */
  onSwitched?: (modelLabel: string) => void;
  /** 该 agent 的 system prompt 注入（可覆盖 ExpertAgent.systemPrompt） */
  systemPromptOverride?: string;
}

export interface HandoffStepResult {
  content: string;
  toolCalls: { toolName: string; input?: unknown }[];
}

/**
 * 跑一个 ExpertAgent 的一次 streamText 调用，返回 content + 累积的 toolCalls。
 * 失败抛错（不静默）——runHandoffWorkflow 内部 try/catch 处理。
 *
 * 注意：toModelEndpoint 需要 credential + apiKey。如果 agent 的 modelId 对应的模型没有可用
 * credential（apiKey 取不到），直接抛错。
 */
export async function runExpertAgentStep(
  agent: ExpertAgent,
  messages: { role: "user" | "assistant" | "system"; content: string }[],
  ctx: HandoffRunnerContext,
): Promise<HandoffStepResult> {
  // 1. 从 agent.modelId 找 ModelListItem + credential
  const model = ctx.availableModels.find((m) => m.id === agent.modelId);
  if (!model) {
    throw new Error(`Handoff target model "${agent.modelId}" not in availableModels`);
  }
  // ModelListItem.credentialId 不一定存在——通过 providerId 找 credential
  const credential = ctx.credentials.find((c) => c.providerId === model.providerId);
  if (!credential) {
    throw new Error(`No credential for provider "${model.providerId}" (model ${agent.modelId})`);
  }
  // 2. 异步取 apiKey
  const apiKey = await ctx.getApiKey(credential.id);
  if (!apiKey) {
    throw new Error(`API key missing for credential "${credential.id}"`);
  }
  // 3. 构造 ModelEndpoint
  const endpoint = toModelEndpoint(model, credential, apiKey);
  // 4. 累积 content + toolCalls
  let fullContent = "";
  const toolCalls: { toolName: string; input?: unknown }[] = [];
  // 5. 调 streamWithFallback
  await streamWithFallback(
    [endpoint],
    messages.map((m) => ({ role: m.role, content: m.content })),
    {
      onDelta: (delta) => {
        fullContent += delta;
        ctx.onDelta?.(delta);
      },
      onSwitched: (_from, to) => {
        ctx.onSwitched?.(to.displayLabel ?? to.modelName);
      },
      onFinalToolCalls: (tcs) => {
        for (const tc of tcs) toolCalls.push(tc);
      },
    },
    {
      signal: ctx.signal,
      // 阶段 F1：actor role 给 UsageEvent 落库用
      actorRole: agent.id,
    },
  );
  return { content: fullContent, toolCalls };
}