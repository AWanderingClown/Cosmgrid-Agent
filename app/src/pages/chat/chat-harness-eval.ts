import { evaluateConversationHarness } from "@/lib/llm/harness/conversation-harness";
import type { ToolExecutionRow } from "@/lib/db";
import type { LanguageModel } from "@/lib/llm/provider-factory";

export function evaluateChatTurnHarness({
  conversationId,
  content,
  sinceIso,
  actualToolCallCount = 0,
  assistantMessageId = null,
  finishReason = "stop",
  judgeModel = null,
  onRowsLoaded,
}: {
  conversationId: string | null;
  content: string;
  sinceIso: string | null;
  actualToolCallCount?: number;
  assistantMessageId?: string | null;
  finishReason?: string | null;
  judgeModel?: LanguageModel | null;
  onRowsLoaded: (rows: ToolExecutionRow[]) => void;
}) {
  return evaluateConversationHarness({
    conversationId,
    content,
    sinceIso,
    actualToolCallCount,
    assistantMessageId,
    finishReason,
    judgeModel,
    onRowsLoaded,
  });
}
