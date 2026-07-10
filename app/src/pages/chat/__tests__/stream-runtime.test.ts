import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChatStreamRuntime } from "@/pages/chat/stream-runtime";
import type { ChatMessage } from "@/pages/chat/types";

const mocks = vi.hoisted(() => ({
  streamWithFallback: vi.fn(),
}));

vi.mock("@/lib/llm/chat-fallback", () => ({
  streamWithFallback: mocks.streamWithFallback,
}));

const chain = [{ modelId: "model-1", modelName: "Model 1", providerType: "openai" }] as never;
const baseMessages = [{ role: "user", content: "保存到文件" }] as never;

describe("runChatStreamRuntime", () => {
  beforeEach(() => {
    mocks.streamWithFallback.mockReset();
  });

  it("正常流式只调用一次模型并返回最终内容", async () => {
    const setMessages = vi.fn();
    mocks.streamWithFallback.mockImplementation(async (_chain, _messages, callbacks) => {
      callbacks.onDelta("hello");
      callbacks.onUsage({ inputTokens: 1, outputTokens: 2, toolCallCount: 1 }, { modelId: "model-1", modelName: "Model 1" }, "stop");
      return { usedModelId: "model-1" };
    });

    const result = await runChatStreamRuntime({
      chain,
      initialMessages: baseMessages,
      assistantId: "assistant-1",
      controller: new AbortController(),
      modelId: "model-1",
      conversationId: "conv-1",
      taskRole: "standard",
      actorRole: "leader",
      routingDecision: null,
      compressionStats: null,
      tools: { write: {} } as never,
      pureMode: false,
      turnImpliesWrite: false,
      turnStartedAt: "2026-07-10T00:00:00.000Z",
      evalHarness: vi.fn(async () => null),
      labels: {
        harnessRetry: "harness retry",
        intentNudgeRetry: "nudge retry",
        switchedTo: (name) => `switched ${name}`,
      },
      setMessages,
      setSwitchNotice: vi.fn(),
      setLastUsage: vi.fn(),
      setHarnessNotice: vi.fn(),
    });

    expect(result.fullContent).toBe("hello");
    expect(result.lastToolCallCount).toBe(1);
    expect(mocks.streamWithFallback).toHaveBeenCalledTimes(1);
  });

  it("写意图但 0 工具调用时触发一次 nudge 重答，并强制 toolChoice required", async () => {
    const setHarnessNotice = vi.fn();
    const evalHarness = vi.fn(async () => null);
    let messagesAtSecondAttempt: unknown;
    const optionCalls: unknown[] = [];

    mocks.streamWithFallback
      .mockImplementationOnce(async (_chain, _messages, callbacks, options) => {
        optionCalls.push(options);
        callbacks.onDelta("我现在保存。");
        callbacks.onUsage({ inputTokens: 1, outputTokens: 2, toolCallCount: 0 }, { modelId: "model-1", modelName: "Model 1" }, "stop");
        return { usedModelId: "model-1" };
      })
      .mockImplementationOnce(async (_chain, messages, callbacks, options) => {
        messagesAtSecondAttempt = messages;
        optionCalls.push(options);
        callbacks.onDelta("已保存");
        callbacks.onUsage({ inputTokens: 2, outputTokens: 3, toolCallCount: 1 }, { modelId: "model-1", modelName: "Model 1" }, "stop");
        return { usedModelId: "model-1" };
      });

    const result = await runChatStreamRuntime({
      chain,
      initialMessages: baseMessages,
      assistantId: "assistant-1",
      controller: new AbortController(),
      modelId: "model-1",
      conversationId: "conv-1",
      taskRole: "standard",
      actorRole: "leader",
      routingDecision: null,
      compressionStats: null,
      tools: { write: {} } as never,
      pureMode: false,
      turnImpliesWrite: true,
      turnStartedAt: "2026-07-10T00:00:00.000Z",
      evalHarness,
      labels: {
        harnessRetry: "harness retry",
        intentNudgeRetry: "nudge retry",
        switchedTo: (name) => `switched ${name}`,
      },
      setMessages: vi.fn((updater) => updater([{ id: "assistant-1", role: "assistant", content: "" } as ChatMessage])),
      setSwitchNotice: vi.fn(),
      setLastUsage: vi.fn(),
      setHarnessNotice,
    });

    expect(result.fullContent).toBe("已保存");
    expect(mocks.streamWithFallback).toHaveBeenCalledTimes(2);
    expect(setHarnessNotice).toHaveBeenCalledWith("nudge retry");
    expect(messagesAtSecondAttempt).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: "我现在保存。" }),
      expect.objectContaining({ role: "user" }),
    ]));
    expect(optionCalls[1]).toEqual(expect.objectContaining({ toolChoice: "required" }));
  });
});
