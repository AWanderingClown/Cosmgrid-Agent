import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrCreateMainChat: vi.fn(),
  rename: vi.fn(),
  touch: vi.fn(),
  createMessage: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  conversations: {
    getOrCreateMainChat: mocks.getOrCreateMainChat,
    rename: mocks.rename,
    touch: mocks.touch,
  },
  messages: {
    create: mocks.createMessage,
  },
}));

import { prepareTurnPersistence } from "@/pages/chat/turn-persistence";

describe("prepareTurnPersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rename.mockResolvedValue(undefined);
    mocks.touch.mockResolvedValue(undefined);
  });

  it("creates a conversation and persists the first user message", async () => {
    mocks.getOrCreateMainChat.mockResolvedValue({ id: "conversation-1" });
    mocks.createMessage.mockResolvedValue({ id: "stored-user-1" });

    const result = await prepareTurnPersistence({
      conversationId: null,
      optimisticUserId: "optimistic-user",
      modelId: "model-1",
      untitledTitle: "Untitled",
      text: "Build the feature",
      attachments: [],
      isFirstMessage: true,
      onPersistenceFailure: vi.fn(),
    });

    expect(result.conversationId).toBe("conversation-1");
    expect(result.userId).toBe("stored-user-1");
    expect(mocks.rename).toHaveBeenCalledWith("conversation-1", "Build the feature");
  });

  it("falls back to memory when conversation creation fails", async () => {
    mocks.getOrCreateMainChat.mockRejectedValue(new Error("database unavailable"));
    const onPersistenceFailure = vi.fn();

    const result = await prepareTurnPersistence({
      conversationId: null,
      optimisticUserId: "optimistic-user",
      modelId: "model-1",
      untitledTitle: "Untitled",
      text: "hello",
      isFirstMessage: true,
      onPersistenceFailure,
    });

    expect(result).toMatchObject({
      conversationId: null,
      userId: "optimistic-user",
    });
    expect(onPersistenceFailure).toHaveBeenCalledOnce();
  });

  it("keeps the optimistic id when saving the user message fails", async () => {
    mocks.createMessage.mockRejectedValue(new Error("write failed"));
    const onPersistenceFailure = vi.fn();

    const result = await prepareTurnPersistence({
      conversationId: "conversation-1",
      optimisticUserId: "optimistic-user",
      modelId: "model-1",
      untitledTitle: "Untitled",
      text: "continue",
      isFirstMessage: false,
      onPersistenceFailure,
    });

    expect(result.userId).toBe("optimistic-user");
    expect(onPersistenceFailure).toHaveBeenCalledOnce();
    expect(mocks.touch).toHaveBeenCalledWith("conversation-1");
  });

  it("persists assistant replies through the returned callback", async () => {
    mocks.createMessage
      .mockResolvedValueOnce({ id: "stored-user-1" })
      .mockResolvedValueOnce({ id: "stored-assistant-1" });

    const result = await prepareTurnPersistence({
      conversationId: "conversation-1",
      optimisticUserId: "optimistic-user",
      modelId: "model-1",
      untitledTitle: "Untitled",
      text: "continue",
      isFirstMessage: false,
      onPersistenceFailure: vi.fn(),
    });

    result.persistAssistant(
      "finished",
      "model-2",
      { inputTokens: 12, outputTokens: 7 },
      "chat",
      2,
    );
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalledTimes(2));
    expect(mocks.createMessage).toHaveBeenLastCalledWith({
      conversationId: "conversation-1",
      role: "assistant",
      content: "finished",
      modelId: "model-2",
      inputTokens: 12,
      outputTokens: 7,
      kind: null,
      toolCallCount: 2,
      parts: null,
    });
  });
});
