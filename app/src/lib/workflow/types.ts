import type { RoleId } from "@/lib/llm/orchestrator";

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
}

export type WorkflowPhase =
  | "read_project"
  | "plan"
  | "review"
  | "debate"
  | "execute"
  | "verify";

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
    planSummary?: string;
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
