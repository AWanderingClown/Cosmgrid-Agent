import type { Dispatch, SetStateAction } from "react";
import { toolExecutions, workflowRuns } from "@/lib/db";
import { writeCache } from "@/lib/llm/semantic-cache";
import type { StreamUsage } from "@/lib/llm/chat-fallback";
import { completeCurrentWorkflowNode, failCurrentWorkflowNode, repairCurrentWorkflowNode } from "@/lib/workflow/reducer";
import { verifyNodeOutcome } from "@/lib/workflow/node-verifier";
import { verifyTask } from "@/lib/llm/evidence/task-verifier";
import { reportTaskOutcome, nodeOutcomeToTaskOutcome } from "@/lib/evals/task-outcome-reporter";
import type { VerificationResult } from "@/lib/llm/evidence/types";
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

      // 阶段3：粗筛（verifyNodeOutcome）通过后再跑细对账（verifyTask）。
      // 错误降级策略：任何抛错都返回 status='inconclusive' + humanSummary 提示
      // "证据加载失败"——绝不因证据系统故障让用户回答"失败"。
      // 关键不变量：粗筛和细对账 failureCode 命名空间区分（粗筛：harness_dirty /
      // no_tool_evidence / empty_output；细对账：evidence_contradicts /
      // evidence_insufficient / evidence_truncated）。
      let verification: VerificationResult | undefined;
      let evidenceIds: string[] = [];
      if (currentNode && outcome?.status === "passed") {
        try {
          const allRows = await toolExecutions.listByConversation(args.conversationId ?? "");
          // StreamingFinalizationResult 暂未带 turnStartedAt；用"5 分钟前"作 sinceIso
          // 兜底窗口——同 selectRowsForMessage 默认窗口一致。
          const sinceIso = new Date(Date.now() - 5 * 60_000).toISOString();
          // 阶段3 第一版：所有验收标准都过，但实际无法在最终化层拉起 verification_closure skill 的
          // 结构化 criteria（这要 skill registry 配合，阶段 3-H UI 完工后再串）。
          // 现在传空数组：verifyTask 会跑声明 ↔ 证据对账，但不跑结构化验收——这样 status 不会
          // 被 failedCriteria 拉成 fails，但 conflicts 仍能捕获模型自报数字与 bash 输出的不一致。
          verification = verifyTask({
            finalContent,
            execRows: allRows,
            assistantMessageId: args.assistantId,
            sinceIso,
            acceptanceCriteria: [],
            workflowRef: { runId: args.workflowRunId, nodeId: currentNode.id },
          });
          evidenceIds = verification.decisionEvidenceIds;
        } catch {
          // 证据加载失败降级 inconclusive（不阻塞主流程）
          verification = {
            status: "inconclusive",
            metCriteria: [],
            failedCriteria: [],
            linkedClaims: [],
            conflicts: [],
            decidedAt: new Date().toISOString(),
            decisionEvidenceIds: [],
            humanSummary: "证据加载失败，请人工复核。",
          };
        }
      }

      if (!outcome || outcome.status === "passed") {
        const nextWorkflow = completeCurrentWorkflowNode({
          snapshot: args.workflowSnapshot,
          summary: finalContent.slice(0, 1200),
          evidenceIds,
          verification,
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
            ...(verification ? { verificationSummary: verification.humanSummary } : {}),
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

      // 阶段4：上报 task_outcomes（Eval Harness 11 指标聚合的源）
      if (args.conversationId && currentNode) {
        const taskOutcomeStatus = outcome?.status ?? "passed";  // outcome 为 null 时按 passed 兜底
        const mapped = nodeOutcomeToTaskOutcome(taskOutcomeStatus);
        void reportTaskOutcome({
          conversationId: args.conversationId,
          nodeId: currentNode.id,
          outcome: mapped.outcome,
          interventionKind: mapped.interventionKind ?? undefined,
          finalSummary: finalContent.slice(0, 200),
        });
      }
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
