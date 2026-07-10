import type { RoleId } from "@/lib/roles";
import type { SemanticIntentRoute } from "./semantic-intent-router";

export type TurnAction =
  | "start_run"
  | "continue_run"
  | "modify_run"
  | "approve_node"
  | "reject_node"
  | "pause_run"
  | "resume_run"
  | "cancel_run"
  | "answer_only";

export type ExecutionMode =
  | "answer_only"
  | "plan_only"
  | "plan_then_execute"
  | "execute_directly";

export interface WorkflowIntent {
  objective: string;
  requestedOutcome: string;
  taskKind: "bugfix" | "feature" | "refactor" | "analysis" | "setup" | "unknown";
  executionMode: ExecutionMode;
  reviewRequested: boolean;
  debateRequested: boolean;
  verificationRequired: boolean;
  securitySensitive: boolean;
  needsWorkspace: boolean;
  stickyUntil: Array<"completed" | "user_override" | "scope_change" | "hard_failure">;
}

export interface TurnIntentDecision {
  action: TurnAction;
  targetRunId: string | null;
  confidence: number;
  reason: string;
  evidenceTurnIds: string[];
  patch?: Partial<WorkflowIntent>;
  /**
   * 5.1 修复（2026-07-02）：消息难度档位（simple/standard/hard）。
   * 与 lib/llm/message-router.ts 的 MessageComplexity 保持一致，但这里内联定义避免循环依赖。
   * 调用方（如 message-router.ts）可以用此字段而不再独立跑一次 classifyMessageComplexity。
   */
  complexity?: "simple" | "standard" | "hard";
  /**
   * M1 修复（2026-07-09）：classifyTurnIntentWithJudge 内部已经跑过一次语义路由，
   * 顺手把结果挂在这里——调用方（如意图诊断面板）不用为了拿同一份 route 再调一次
   * routeTurnIntentSemantically（省一次 keywordEmbed + 逐样例余弦相似度）。
   * cancel_run/pause_run 走 L0 硬规则短路时不会算语义路由，此时为 undefined。
   */
  semanticRoute?: SemanticIntentRoute;
}

export type WorkflowPhase =
  | "read_project"
  | "plan"
  | "review"
  | "debate"
  | "execute"
  | "verify";

export type WorkflowPlanSourceKind =
  | "message"
  | "file"
  | "debate_result"
  | "degraded_debate";

export interface WorkflowPlanSource {
  kind: WorkflowPlanSourceKind;
  ref: string;
  summary: string;
  boundAt: string;
  phase?: WorkflowPhase;
  label?: string;
}

export interface WorkflowActiveSkill {
  id: string;
  label: string;
  selectedAt: string;
  reason: string;
}

export type WorkflowRunStatus =
  | "running"
  | "waiting_user"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_user"
  | "done"
  | "failed"
  | "skipped";

export interface WorkflowNode {
  id: string;
  phase: WorkflowPhase;
  title: string;
  status: WorkflowNodeStatus;
  optional: boolean;
  dependsOn: string[];
  assignedRoles: RoleId[];
  assignedModelId?: string | null;
  autoAdvance: "always" | "if_confident" | "never";
  /** Harness 工程实施计划阶段1：verify 阶段验收失败后已经自动打回 execute 修复的次数。
   *  达到 node-verifier.ts 的 MAX_REPAIR_ATTEMPTS 后不再自动重试，进入 blocked。 */
  repairAttempts?: number;
  outputs?: {
    summary?: string;
    artifactIds?: string[];
    toolExecutionIds?: string[];
  };
}

export interface NextAction {
  id: string;
  labelKey: string;
  targetPhase: WorkflowPhase;
  recommended: boolean;
  reason: string;
  risk: "low" | "medium" | "high";
  estimatedCost: "low" | "medium" | "high";
}

export interface WorkflowSnapshot {
  version: 1;
  runId: string;
  conversationId: string;
  projectId?: string | null;
  status: WorkflowRunStatus;
  intent: WorkflowIntent;
  currentNodeId: string | null;
  nodes: WorkflowNode[];
  nextActions: NextAction[];
  context: {
    workspacePath?: string | null;
    projectFacts: string[];
    activeSkill?: WorkflowActiveSkill;
    planSummary?: string;
    planSource?: WorkflowPlanSource;
    reviewSummary?: string;
    debateSummary?: string;
    changedFiles: string[];
    verificationSummary?: string;
    riskLevel: "low" | "medium" | "high";
  };
  pendingDecision?: {
    nodeId: string;
    kind: "approve_execute" | "pick_next_step" | "resolve_ambiguity";
    choices: string[];
  };
}

export const WORKFLOW_VERSION = 1 as const;
