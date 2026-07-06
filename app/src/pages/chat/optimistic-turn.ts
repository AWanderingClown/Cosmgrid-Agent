import type { Attachment } from "@/lib/llm/attachments";

export interface OptimisticMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  attachments?: Attachment[];
}

interface CreateOptimisticUserTurnArgs<T extends OptimisticMessage> {
  messages: readonly T[];
  text: string;
  attachments?: Attachment[];
  id?: string;
  createdAt?: string;
}

export function createOptimisticUserTurn<T extends OptimisticMessage>({
  messages,
  text,
  attachments,
  id = crypto.randomUUID(),
  createdAt = new Date().toISOString(),
}: CreateOptimisticUserTurnArgs<T>) {
  const userMsg = {
    id,
    role: "user" as const,
    content: text,
    createdAt,
    ...(attachments?.length ? { attachments } : {}),
  };

  return {
    userMsg,
    newMessages: [...messages, userMsg],
  };
}
