// Harness 工程实施计划阶段1 —— 统一节点结果类型。
// 把"模型生成了一段非空回答"和"独立验收器确认节点目标已经满足"分开：
// 只有 NodeOutcome.status === "passed" 才允许 workflow 节点进入 done。

export type NodeOutcomeStatus = "passed" | "failed" | "blocked" | "needs_user" | "retryable";

export interface NodeOutcome {
  status: NodeOutcomeStatus;
  summary: string;
  evidenceIds: string[];
  artifactIds: string[];
  toolExecutionIds: string[];
  failureCode?: string;
  retryHint?: string;
  stopReason?: string;
}
