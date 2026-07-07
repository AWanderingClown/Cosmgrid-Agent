import type { TFunction } from "i18next";
import type { StreamCallbacks, StreamUsage } from "@/lib/llm/chat-fallback";
import type { ChatMessage } from "./types";

export interface StreamingTurnState {
  fullContent: string;
  lastUsage?: StreamUsage;
  lastModelId: string | null;
  lastResultModelId?: string;
  lastResolvedModelLabel?: string;
  lastToolCallCount: number;
  lastFinishReason: string;
}

export function createStreamingTurnState(initialModelId: string | null): StreamingTurnState {
  return {
    fullContent: "",
    lastModelId: initialModelId,
    lastToolCallCount: 0,
    lastFinishReason: "stop",
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
    onSwitched: (_from, to, reason) => {
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
      // 2026-07-07 加：detail 是触发这次自动恢复的真实原因（首次调用失败的错误文本）。
      // 之前这条提示只有一句静态"系统已用 CLI 官方会话原生续跑"，看不出为什么触发——
      // 用户不会用 devtools 控制台去查那条 console.error，只能干等或来回问。
      // 直接拼进同一条 UI 提示里，不需要任何调试工具就能看到根因。
      const base = args.t(`chat.recovery.${mode}`);
      args.setSwitchNotice(detail ? `${base}（原因：${detail}）` : base);
    },
    onStatus: (status) => {
      args.setSwitchNotice(status);
    },
    onResolvedModel: (actualModelName) => {
      args.state.lastResolvedModelLabel = actualModelName;
      args.setMessages((prev) =>
        prev.map((m) => (m.id === args.assistantId ? { ...m, modelLabel: actualModelName } : m)),
      );
    },
    onUsage: (usage, usedModel, finishReason) => {
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
