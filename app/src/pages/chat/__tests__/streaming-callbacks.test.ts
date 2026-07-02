import { describe, expect, it } from "vitest";
import type { ModelEndpoint, StreamUsage } from "@/lib/llm/chat-fallback";
import type { ChatMessage } from "../types";
import { createStreamingTurnCallbacks, createStreamingTurnState } from "../streaming-callbacks";

function endpoint(id: string, name = id, displayLabel?: string): ModelEndpoint {
  return {
    modelId: id,
    modelName: name,
    providerType: "openai",
    providerId: `provider-${id}`,
    apiCredentialId: `credential-${id}`,
    apiKey: "key",
    displayLabel,
  };
}

function createMessageHarness() {
  let messages: ChatMessage[] = [
    { id: "assistant-1", role: "assistant", content: "", modelLabel: "MiniMax-M3" },
  ];
  const setMessages = (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    messages = updater(messages);
  };
  return {
    get messages() {
      return messages;
    },
    setMessages,
  };
}

const t = ((key: string, options?: Record<string, unknown>) => {
  if (key === "chat.switchedTo") return `切换到 ${options?.name}`;
  if (key.startsWith("chat.recovery.")) return `恢复：${key.split(".").at(-1)}`;
  return key;
}) as never;

describe("createStreamingTurnCallbacks", () => {
  it("appends streamed deltas to the assistant message and ignores aborted deltas", () => {
    const controller = new AbortController();
    const state = createStreamingTurnState("model-a");
    const harness = createMessageHarness();
    const callbacks = createStreamingTurnCallbacks({
      assistantId: "assistant-1",
      controller,
      state,
      t,
      setMessages: harness.setMessages,
      setSwitchNotice: () => {},
      setLastUsage: () => {},
    });

    callbacks.onDelta("你");
    callbacks.onDelta("好");
    expect(state.fullContent).toBe("你好");
    expect(harness.messages[0]?.content).toBe("你好");

    controller.abort();
    callbacks.onDelta("不会出现");
    expect(state.fullContent).toBe("你好");
    expect(harness.messages[0]?.content).toBe("你好");
  });

  it("records model switching, recovery status, resolved model label, and final usage", () => {
    const state = createStreamingTurnState("model-a");
    const harness = createMessageHarness();
    const notices: string[] = [];
    let lastUsage: StreamUsage | null = null;
    const callbacks = createStreamingTurnCallbacks({
      assistantId: "assistant-1",
      controller: new AbortController(),
      state,
      t,
      setMessages: harness.setMessages,
      setSwitchNotice: (notice) => notices.push(notice ?? ""),
      setLastUsage: (usage) => {
        lastUsage = usage;
      },
    });

    callbacks.onSwitched?.(endpoint("model-a"), endpoint("model-b", "kimi-k2", "Kimi K2"), { kind: "cooldown" });
    callbacks.onRecovered?.("context_replay");
    callbacks.onStatus?.("正在重放上下文");
    callbacks.onResolvedModel?.("kimi-k2-actual", endpoint("model-b"));
    callbacks.onUsage?.({ inputTokens: 10, outputTokens: 20, toolCallCount: 2 }, endpoint("model-b", "kimi-k2", "Kimi K2"), "stop", false);

    expect(notices).toEqual(["切换到 Kimi K2", "恢复：context_replay", "正在重放上下文"]);
    expect(lastUsage).toEqual({ inputTokens: 10, outputTokens: 20, toolCallCount: 2 });
    expect(state.lastUsage).toEqual(lastUsage);
    expect(state.lastModelId).toBe("model-b");
    expect(state.lastToolCallCount).toBe(2);
    expect(state.lastFinishReason).toBe("stop");
    expect(harness.messages[0]).toMatchObject({
      switched: true,
      switchedTo: "Kimi K2",
      modelLabel: "kimi-k2-actual",
      usage: lastUsage,
    });
  });
});
