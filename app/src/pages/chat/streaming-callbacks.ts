import type { TFunction } from "i18next";
import type { StreamCallbacks, StreamUsage } from "@/lib/llm/chat-fallback";
import type { LlmInvocationAuditEvent } from "@/lib/llm/invocation-audit";
import type { ChatMessage } from "./types";

export interface StreamingTurnState {
  fullContent: string;
  lastUsage?: StreamUsage;
  lastModelId: string | null;
  lastResultModelId?: string;
  lastResolvedModelLabel?: string;
  lastToolCallCount: number;
  lastFinishReason: string;
  invocationAudits: LlmInvocationAuditEvent[];
  /** Harness 工程实施计划阶段1：本轮最终（重试耗尽后）Harness 是否仍判定编造，
   *  供 stream-finalization.ts 的节点验收门控消费。纯聊天模式（pureMode）恒为 false。 */
  harnessDirty: boolean;
}

export function createStreamingTurnState(initialModelId: string | null): StreamingTurnState {
  return {
    fullContent: "",
    lastModelId: initialModelId,
    lastToolCallCount: 0,
    lastFinishReason: "stop",
    invocationAudits: [],
    harnessDirty: false,
  };
}

export function createStreamingTurnCallbacks(args: {
  assistantId: string;
  controller: AbortController;
  state: StreamingTurnState;
  t: TFunction;
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  setSwitchNotice: (notice: string | null) => void;
  setLastUsage: (usage: StreamUsage | null) => void;
}): StreamCallbacks {
  return {
    onDelta: (delta) => {
      if (args.controller.signal.aborted) return;
      args.state.fullContent += delta;
      args.setMessages((prev) =>
        prev.map((m) => (m.id === args.assistantId ? { ...m, content: args.state.fullContent } : m)),
      );
    },
    // 2026-07-15 review 修复：原来只有 onDelta 检查了 controller.signal.aborted，
    // 其余六个回调完全没查。用户点停止/切会话后，如果这一轮 streamWithFallback 仍在跑
    // （比如撞到 D4 修复前那个"续接批次之间漏检 abort"的边界，或者单纯是 abort 信号
    // 传播到真正终止调用之间有时间差），这些回调会继续往 setSwitchNotice/setLastUsage
    // 这类跨会话共享的顶层 state 里写数据——用户已经切到别的会话，界面却冒出上一轮
    // "已切换到 XXX"提示条，或者"上次调用消耗"显示的是别的会话残留的调用结果。
    // 统一在这几个回调开头补上跟 onDelta 一样的 aborted 检查。
    onSwitched: (_from, to, reason) => {
      if (args.controller.signal.aborted) return;
      const label = to.displayLabel ?? to.modelName;
      args.setSwitchNotice(args.t("chat.switchedTo", { name: label }));
      args.setMessages((prev) =>
        prev.map((m) =>
          m.id === args.assistantId
            ? { ...m, switched: true, switchedTo: label, modelLabel: label, switchReason: reason }
            : m,
        ),
      );
    },
    onRecovered: (mode, detail) => {
      if (args.controller.signal.aborted) return;
      // 2026-07-07 加：detail 是触发这次自动恢复的真实原因（首次调用失败的错误文本）。
      // 之前这条提示只有一句静态"系统已用 CLI 官方会话原生续跑"，看不出为什么触发——
      // 用户不会用 devtools 控制台去查那条 console.error，只能干等或来回问。
      // 直接拼进同一条 UI 提示里，不需要任何调试工具就能看到根因。
      const base = args.t(`chat.recovery.${mode}`);
      args.setSwitchNotice(detail ? `${base}（原因：${detail}）` : base);
    },
    onStatus: (status) => {
      if (args.controller.signal.aborted) return;
      args.setSwitchNotice(status);
    },
    onInvocationAudit: (event) => {
      if (args.controller.signal.aborted) return;
      args.state.invocationAudits = [...args.state.invocationAudits, event];
      args.setMessages((prev) =>
        prev.map((m) =>
          m.id === args.assistantId
            ? { ...m, llmInvocations: [...(m.llmInvocations ?? []), event] }
            : m,
        ),
      );
    },
    onResolvedModel: (actualModelName) => {
      if (args.controller.signal.aborted) return;
      args.state.lastResolvedModelLabel = actualModelName;
      args.setMessages((prev) =>
        prev.map((m) => (m.id === args.assistantId ? { ...m, modelLabel: actualModelName } : m)),
      );
    },
    onUsage: (usage, usedModel, finishReason) => {
      if (args.controller.signal.aborted) return;
      args.state.lastUsage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        toolCallCount: usage.toolCallCount,
      };
      args.state.lastModelId = usedModel.modelId ?? null;
      args.state.lastToolCallCount = usage.toolCallCount;
      args.state.lastFinishReason = finishReason;
      args.setLastUsage(args.state.lastUsage ?? null);
      args.setMessages((prev) =>
        prev.map((m) =>
          m.id === args.assistantId
            ? {
                ...m,
                usage: args.state.lastUsage,
                modelLabel: args.state.lastResolvedModelLabel ?? usedModel.displayLabel ?? usedModel.modelName,
              }
            : m,
        ),
      );
    },
  };
}
