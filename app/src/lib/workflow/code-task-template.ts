import type { RoleId } from "@/lib/llm/orchestrator";
import {
  WORKFLOW_VERSION,
  type ExecutionMode,
  type NextAction,
  type WorkflowIntent,
  type WorkflowNode,
  type WorkflowPhase,
  type WorkflowSnapshot,
} from "./types";

const PHASE_ROLE_MAP: Record<WorkflowPhase, RoleId[]> = {
  read_project: ["leader"],
  plan: ["architect"],
  review: ["reviewer"],
  debate: ["reviewer"],
  execute: ["frontend", "backend"],
  verify: ["runner", "tester"],
};

const PHASE_TITLE: Record<WorkflowPhase, string> = {
  read_project: "读取项目",
  plan: "制定方案",
  review: "评审方案",
  debate: "多模型博弈",
  execute: "执行方案",
  verify: "验证结果",
};

function node(id: WorkflowPhase, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    phase: id,
    title: PHASE_TITLE[id],
    status: "pending",
    optional: id === "review" || id === "debate",
    dependsOn: id === "read_project" ? [] : ["read_project"],
    assignedRoles: PHASE_ROLE_MAP[id],
    assignedModelId: null,
    autoAdvance: id === "read_project" || id === "verify" ? "always" : "never",
    ...overrides,
  };
}

export function createDefaultWorkflowIntent(args: {
  objective: string;
  executionMode?: ExecutionMode;
  needsWorkspace?: boolean;
}): WorkflowIntent {
  return {
    objective: args.objective.trim() || "未命名任务",
    requestedOutcome: args.objective.trim() || "完成用户当前任务",
    taskKind: "unknown",
    executionMode: args.executionMode ?? "plan_only",
    reviewRequested: false,
    debateRequested: false,
    verificationRequired: true,
    securitySensitive: false,
    needsWorkspace: args.needsWorkspace ?? true,
    stickyUntil: ["completed", "user_override", "scope_change", "hard_failure"],
  };
}

export function defaultNextActionsForPhase(phase: WorkflowPhase): NextAction[] {
  if (phase === "read_project") {
    return [
      {
        id: "make_plan",
        labelKey: "chat.workflow.nextActions.makePlan",
        targetPhase: "plan",
        recommended: true,
        reason: "已经掌握项目基本事实，可以进入方案阶段。",
        risk: "low",
        estimatedCost: "medium",
      },
    ];
  }
  if (phase === "plan") {
    return [
      {
        id: "review_plan",
        labelKey: "chat.workflow.nextActions.reviewPlan",
        targetPhase: "review",
        recommended: false,
        reason: "让另一个模型评审方案可降低返工风险。",
        risk: "low",
        estimatedCost: "medium",
      },
      {
        id: "debate_options",
        labelKey: "chat.workflow.nextActions.debateOptions",
        targetPhase: "debate",
        recommended: false,
        reason: "多方案不确定时可让模型博弈。",
        risk: "low",
        estimatedCost: "high",
      },
      {
        id: "execute_plan",
        labelKey: "chat.workflow.nextActions.executePlan",
        targetPhase: "execute",
        recommended: true,
        reason: "方案已产出，可以进入执行。",
        risk: "medium",
        estimatedCost: "high",
      },
    ];
  }
  if (phase === "execute") {
    return [
      {
        id: "verify_changes",
        labelKey: "chat.workflow.nextActions.verifyChanges",
        targetPhase: "verify",
        recommended: true,
        reason: "执行后需要验证构建、测试和结果。",
        risk: "low",
        estimatedCost: "medium",
      },
    ];
  }
  return [];
}

export function createCodeTaskWorkflowSnapshot(args: {
  runId: string;
  conversationId: string;
  projectId?: string | null;
  workspacePath?: string | null;
  objective: string;
  executionMode?: ExecutionMode;
}): WorkflowSnapshot {
  const intent = createDefaultWorkflowIntent({
    objective: args.objective,
    executionMode: args.executionMode,
    needsWorkspace: true,
  });
  return {
    version: WORKFLOW_VERSION,
    runId: args.runId,
    conversationId: args.conversationId,
    projectId: args.projectId ?? null,
    status: "running",
    intent,
    currentNodeId: "read_project",
    nodes: [
      node("read_project", { status: "ready" }),
      node("plan", { dependsOn: ["read_project"] }),
      node("review", { dependsOn: ["plan"] }),
      node("debate", { dependsOn: ["plan"] }),
      node("execute", { dependsOn: ["plan"] }),
      node("verify", { dependsOn: ["execute"] }),
    ],
    nextActions: [],
    context: {
      workspacePath: args.workspacePath ?? null,
      projectFacts: [],
      changedFiles: [],
      riskLevel: "low",
    },
  };
}

export function activeNode(snapshot: WorkflowSnapshot): WorkflowNode | null {
  return snapshot.nodes.find((n) => n.id === snapshot.currentNodeId) ?? null;
}
