import type { Dispatch, SetStateAction } from "react";
import { workflowRuns } from "@/lib/db";
import { writeCache } from "@/lib/llm/semantic-cache";
import type { StreamUsage } from "@/lib/llm/chat-fallback";
import { completeCurrentWorkflowNode } from "@/lib/workflow/reducer";
import type { WorkflowSnapshot } from "@/lib/workflow/types";
import type { ChatMessage } from "@/pages/chat/types";

interface StreamingFinalizationResult {
  fullContent: string;
  lastModelId: string | null;
  lastResultModelId?: string;
  lastUsage?: StreamUsage;
  lastToolCallCount: number;
}

type PersistAssistant = (
  content: string,
  modelId: string | null,
  usage?: { inputTokens: number; outputTokens: number },
  kind?: ChatMessage["kind"],
  toolCallCount?: number | null,
) => void;

export interface FinalizeStreamedChatTurnArgs {
  text: string;
  assistantId: string;
  assistantMessage: ChatMessage;
  streamingResult: StreamingFinalizationResult;
  conversationId: string | null;
  cacheEligible: boolean;
  taskRole: string;
  shouldCompleteWorkflowNode: boolean;
  workflowSnapshot: WorkflowSnapshot | null;
  workflowRunId: string | null;
  controllerAborted: boolean;
  persistAssistant: PersistAssistant;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  applyWorkflowSnapshot: (snapshot: WorkflowSnapshot | null) => void;
}

export interface FinalizedStreamedChatTurn {
  finalContent: string;
  finalAssistantMsg: ChatMessage;
}

export async function finalizeStreamedChatTurn(
  args: FinalizeStreamedChatTurnArgs,
): Promise<FinalizedStreamedChatTurn> {
  const finalContent = args.streamingResult.fullContent;
  args.setMessages((prev) =>
    prev.map((message) =>
      message.id === args.assistantId
        ? { ...message, toolCallCount: args.streamingResult.lastToolCallCount }
        : message,
    ),
  );
  args.persistAssistant(
    finalContent,
    args.streamingResult.lastModelId,
    args.streamingResult.lastUsage,
    undefined,
    args.streamingResult.lastToolCallCount,
  );

  if (
    args.conversationId &&
    args.shouldCompleteWorkflowNode &&
    args.workflowSnapshot &&
    args.workflowRunId &&
    finalContent &&
    !args.controllerAborted
  ) {
    try {
      const nextWorkflow = completeCurrentWorkflowNode({
        snapshot: args.workflowSnapshot,
        summary: finalContent.slice(0, 1200),
      });
      await workflowRuns.saveSnapshot({
        runId: args.workflowRunId,
        snapshot: nextWorkflow,
        eventType: "workflow.node_completed",
        eventPayload: {
          nodeId: args.workflowSnapshot.currentNodeId,
          summaryPreview: finalContent.slice(0, 240),
        },
      });
      args.applyWorkflowSnapshot(nextWorkflow);
    } catch {
      // workflow 状态更新失败不影响正常回答
    }
  }

  if (args.cacheEligible && finalContent && !args.controllerAborted) {
    void Promise.resolve(
      writeCache(
        args.text,
        finalContent,
        args.streamingResult.lastResultModelId ?? args.streamingResult.lastModelId ?? "",
        args.taskRole,
      ),
    ).catch(() => {});
  }

  return {
    finalContent,
    finalAssistantMsg: { ...args.assistantMessage, content: finalContent },
  };
}
