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
    callbacks.onInvocationAudit?.({
      modelId: "model-b",
      modelName: "kimi-k2",
      providerType: "openai",
      providerKind: "api",
      status: "success",
      startedAt: "2026-07-07T00:00:00.000Z",
      endedAt: "2026-07-07T00:00:01.000Z",
      latencyMs: 1000,
      finishReason: "stop",
    });
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
      llmInvocations: [expect.objectContaining({ modelId: "model-b", status: "success" })],
    });
  });

  // 真实事故（2026-07-05）：onSwitched 的第三个参数 reason 之前被 (_from, to) 解构直接丢掉，
  // 导致工作面板不管真实原因是什么，一律显示写死的"限额自动切换"——用户所有 provider
  // 都有额度，却每次都被告知"限额"。这里锁住 reason 必须真实存进消息，不能再丢。
  it("真实切换原因（非 cooldown）也要存进消息，不能被丢掉", () => {
    const state = createStreamingTurnState("model-a");
    const harness = createMessageHarness();
    const callbacks = createStreamingTurnCallbacks({
      assistantId: "assistant-1",
      controller: new AbortController(),
      state,
      t,
      setMessages: harness.setMessages,
      setSwitchNotice: () => {},
      setLastUsage: () => {},
    });

    callbacks.onSwitched?.(endpoint("model-a"), endpoint("model-b", "kimi-k2", "Kimi K2"), {
      kind: "error",
      category: "timeout",
    });

    expect(harness.messages[0]).toMatchObject({
      switched: true,
      switchReason: { kind: "error", category: "timeout" },
    });
  });

  // 2026-07-15 review 修复回归测试：原来只有 onDelta 检查了 aborted，其余六个回调完全
  // 没查，用户停止/切会话后如果上一轮 streamWithFallback 仍在跑，这些回调会继续往
  // setSwitchNotice/setLastUsage 这类跨会话共享的顶层 state 里写数据——用户已经切到别
  // 的会话，界面却冒出上一轮"已切换到 XXX"提示条，或"上次调用消耗"显示的是别的会话
  // 残留的调用结果。这里锁住：signal 已 abort 后，六个回调全都不应该再写任何全局状态。
  it("controller 已 abort 后，onSwitched/onRecovered/onStatus/onInvocationAudit/onResolvedModel/onUsage 全部不应该再写任何全局状态", () => {
    const controller = new AbortController();
    const state = createStreamingTurnState("model-a");
    const harness = createMessageHarness();
    const notices: string[] = [];
    let lastUsageCalls = 0;
    const callbacks = createStreamingTurnCallbacks({
      assistantId: "assistant-1",
      controller,
      state,
      t,
      setMessages: harness.setMessages,
      setSwitchNotice: (notice) => notices.push(notice ?? ""),
      setLastUsage: () => {
        lastUsageCalls++;
      },
    });

    controller.abort();
    const messagesBefore = harness.messages[0];

    callbacks.onSwitched?.(endpoint("model-a"), endpoint("model-b", "kimi-k2", "Kimi K2"), { kind: "cooldown" });
    callbacks.onRecovered?.("context_replay");
    callbacks.onStatus?.("正在重放上下文");
    callbacks.onResolvedModel?.("kimi-k2-actual", endpoint("model-b"));
    callbacks.onInvocationAudit?.({
      modelId: "model-b",
      modelName: "kimi-k2",
      providerType: "openai",
      providerKind: "api",
      status: "success",
      startedAt: "2026-07-07T00:00:00.000Z",
      endedAt: "2026-07-07T00:00:01.000Z",
      latencyMs: 1000,
      finishReason: "stop",
    });
    callbacks.onUsage?.({ inputTokens: 10, outputTokens: 20, toolCallCount: 2 }, endpoint("model-b", "kimi-k2", "Kimi K2"), "stop", false);

    expect(notices).toEqual([]);
    expect(lastUsageCalls).toBe(0);
    expect(harness.messages[0]).toEqual(messagesBefore);
    expect(state.lastUsage).toBeUndefined();
    expect(state.invocationAudits).toEqual([]);
  });
});
