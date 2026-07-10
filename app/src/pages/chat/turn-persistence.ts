import { conversations, messages } from "@/lib/db";
import type { Attachment } from "@/lib/llm/attachments";
import type { ChatMessage } from "@/pages/chat/types";

interface PrepareTurnPersistenceOptions {
  conversationId: string | null;
  optimisticUserId: string;
  modelId: string;
  untitledTitle: string;
  text: string;
  attachments?: Attachment[];
  isFirstMessage: boolean;
  isAborted?: () => boolean;
  onPersistenceFailure: () => void;
}

export interface PreparedTurnPersistence {
  conversationId: string | null;
  userId: string;
  aborted: boolean;
  persistAssistant: (
    content: string,
    modelId: string | null,
    usage?: { inputTokens: number; outputTokens: number },
    kind?: ChatMessage["kind"],
    toolCallCount?: number | null,
  ) => void;
}

export async function prepareTurnPersistence(
  options: PrepareTurnPersistenceOptions,
): Promise<PreparedTurnPersistence> {
  let conversationId = options.conversationId;
  let userId = options.optimisticUserId;

  if (!conversationId) {
    try {
      const conversation = await conversations.getOrCreateMainChat(
        options.modelId,
        options.untitledTitle,
      );
      conversationId = conversation.id;
    } catch (error) {
      console.error(
        "[prepareTurnPersistence] conversation creation failed; using memory only",
        error,
      );
      options.onPersistenceFailure();
    }
  }

  if (options.isAborted?.()) {
    return buildResult(conversationId, userId, true, options.onPersistenceFailure);
  }

  if (conversationId) {
    try {
      userId = (
        await messages.create({
          conversationId,
          role: "user",
          content: options.text,
          attachments: options.attachments?.length
            ? JSON.stringify(options.attachments)
            : null,
        })
      ).id;
    } catch (error) {
      console.error(
        "[prepareTurnPersistence] user message save failed; using memory only",
        error,
      );
      options.onPersistenceFailure();
    }

    if (options.isFirstMessage) {
      void conversations
        .rename(conversationId, options.text.slice(0, 40))
        .catch(() => {});
    } else {
      void conversations.touch(conversationId).catch(() => {});
    }
  }

  return buildResult(
    conversationId,
    userId,
    options.isAborted?.() ?? false,
    options.onPersistenceFailure,
  );
}

function buildResult(
  conversationId: string | null,
  userId: string,
  aborted: boolean,
  onPersistenceFailure: () => void,
): PreparedTurnPersistence {
  return {
    conversationId,
    userId,
    aborted,
    persistAssistant: (content, modelId, usage, kind, toolCallCount) => {
      if (!conversationId || !content) return;
      void messages
        .create({
          conversationId,
          role: "assistant",
          content,
          modelId,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          kind: kind && kind !== "chat" ? kind : null,
          toolCallCount: toolCallCount ?? null,
        })
        .catch((error) => {
          console.error(
            "[prepareTurnPersistence] assistant message save failed",
            error,
          );
          onPersistenceFailure();
        });
    },
  };
}
