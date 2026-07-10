import type { Dispatch, SetStateAction } from "react";
import { toolExecutions, workflowRuns } from "@/lib/db";
import { writeCache } from "@/lib/llm/semantic-cache";
import type { StreamUsage } from "@/lib/llm/chat-fallback";
import { completeCurrentWorkflowNode, failCurrentWorkflowNode, repairCurrentWorkflowNode } from "@/lib/workflow/reducer";
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
      // Harness 工程实施计划阶段1：本轮是否有工具被用户拒绝（denied），据此判定 needs_user，
      // 不能把"用户不同意写"当成"验收失败"处理。查失败不阻塞正常完成路径。
      const userDeniedPermission = await toolExecutions
        .listByMessage(args.assistantId)
        .then((rows) => rows.some((row) => row.status === "denied"))
        .catch(() => false);
      // Harness 工程实施计划阶段1：不再是"非空回复就完成"——先跑独立验收器，
      // 只有 passed 才真的把节点标 done；harnessDirty/无工具证据时 failed，
      // verify 阶段 failed 且未达修复上限时降级成 retryable 打回 execute 重来，
      // 写 workflow.node_failed_verification / node_repair_retry / node_blocked 事件。
      const outcome = currentNode
        ? verifyNodeOutcome({
            phase: currentNode.phase,
            harnessDirty: args.streamingResult.harnessDirty,
            toolCallCount: args.streamingResult.lastToolCallCount,
            hasSummary: finalContent.length > 0,
            userDeniedPermission,
            repairAttempts: currentNode.repairAttempts ?? 0,
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
            // Harness 工程实施计划阶段1 退出标准："所有节点完成事件都有 NodeOutcome"。
            // outcome 在没有 currentNode 时兜底为 null（极端边界），此时事件仍然落地，
            // 只是没有 outcome 字段可附。
            ...(outcome ? { outcome } : {}),
          },
        });
        args.applyWorkflowSnapshot(nextWorkflow);
      } else if (outcome.status === "retryable") {
        const nextWorkflow = repairCurrentWorkflowNode({ snapshot: args.workflowSnapshot, outcome });
        await workflowRuns.saveSnapshot({
          runId: args.workflowRunId,
          snapshot: nextWorkflow,
          eventType: "workflow.node_repair_retry",
          eventPayload: {
            nodeId: args.workflowSnapshot.currentNodeId,
            failureCode: outcome.failureCode,
            repairAttempts: (currentNode?.repairAttempts ?? 0) + 1,
            summaryPreview: finalContent.slice(0, 240),
          },
        });
        args.applyWorkflowSnapshot(nextWorkflow);
      } else if (outcome.status === "failed" || outcome.status === "blocked") {
        const nextWorkflow = failCurrentWorkflowNode({ snapshot: args.workflowSnapshot, outcome });
        await workflowRuns.saveSnapshot({
          runId: args.workflowRunId,
          snapshot: nextWorkflow,
          eventType: outcome.status === "blocked" ? "workflow.node_blocked" : "workflow.node_failed_verification",
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
