import type { Dispatch, SetStateAction } from "react";
import { workflowRuns } from "@/lib/db";
import { writeCache } from "@/lib/llm/semantic-cache";
import type { StreamUsage } from "@/lib/llm/chat-fallback";
import { completeCurrentWorkflowNode, failCurrentWorkflowNode } from "@/lib/workflow/reducer";
import { verifyNodeOutcome } from "@/lib/workflow/node-verifier";
import type { WorkflowSnapshot } from "@/lib/workflow/types";
import type { ChatMessage } from "@/pages/chat/types";

interface StreamingFinalizationResult {
  fullContent: string;
  lastModelId: string | null;
  lastResultModelId?: string;
  lastUsage?: StreamUsage;
  lastToolCallCount: number;
  /** Harness 工程实施计划阶段1：本轮最终 Harness 判定，供节点验收门控消费。 */
  harnessDirty: boolean;
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
      const currentNode = args.workflowSnapshot.nodes.find(
        (n) => n.id === args.workflowSnapshot!.currentNodeId,
      );
      // Harness 工程实施计划阶段1：不再是"非空回复就完成"——先跑独立验收器，
      // 只有 passed 才真的把节点标 done；harnessDirty/无工具证据时标 failed，
      // 写 workflow.node_failed_verification 事件，节点保持未完成让用户能看到。
      const outcome = currentNode
        ? verifyNodeOutcome({
            phase: currentNode.phase,
            harnessDirty: args.streamingResult.harnessDirty,
            toolCallCount: args.streamingResult.lastToolCallCount,
            hasSummary: finalContent.length > 0,
          })
        : null;

      if (!outcome || outcome.status === "passed") {
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
      } else if (outcome.status === "failed" || outcome.status === "blocked") {
        const nextWorkflow = failCurrentWorkflowNode({ snapshot: args.workflowSnapshot, outcome });
        await workflowRuns.saveSnapshot({
          runId: args.workflowRunId,
          snapshot: nextWorkflow,
          eventType: "workflow.node_failed_verification",
          eventPayload: {
            nodeId: args.workflowSnapshot.currentNodeId,
            failureCode: outcome.failureCode,
            summaryPreview: finalContent.slice(0, 240),
          },
        });
        args.applyWorkflowSnapshot(nextWorkflow);
      }
      // needs_user：节点保持原状，不落新事件——等用户下一步指示（拒绝权限/主动取消场景）。
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
