import { defaultNextActionsForPhase } from "./code-task-template";
import type { NodeOutcome } from "./node-outcome";
import type { TurnIntentDecision, WorkflowActiveSkill, WorkflowNode, WorkflowPhase, WorkflowPlanSource, WorkflowSnapshot } from "./types";
import type { VerificationResult } from "@/lib/llm/evidence/types";

function updateNode(snapshot: WorkflowSnapshot, nodeId: string, patch: Partial<WorkflowNode>): WorkflowSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node),
  };
}

function phaseNode(snapshot: WorkflowSnapshot, phase: WorkflowPhase): WorkflowNode | null {
  return snapshot.nodes.find((node) => node.phase === phase) ?? null;
}

function setCurrentPhase(snapshot: WorkflowSnapshot, phase: WorkflowPhase): WorkflowSnapshot {
  const node = phaseNode(snapshot, phase);
  if (!node) return snapshot;
  return {
    ...snapshot,
    currentNodeId: node.id,
    nodes: snapshot.nodes.map((n) =>
      n.id === node.id && n.status === "pending" ? { ...n, status: "ready" } : n,
    ),
  };
}

export function completeCurrentWorkflowNode(args: {
  snapshot: WorkflowSnapshot;
  summary?: string;
  planSource?: WorkflowPlanSource;
  artifactIds?: string[];
  toolExecutionIds?: string[];
  /** 阶段3（2026-07-11）：Task Verifier 产生的 EvidenceRef.id 列表，透传到 outputs.evidenceIds。 */
  evidenceIds?: string[];
  /** 阶段3：Task Verifier 结构化结果，透传到 outputs.verification。 */
  verification?: VerificationResult;
}): WorkflowSnapshot {
  const node = args.snapshot.nodes.find((n) => n.id === args.snapshot.currentNodeId);
  if (!node) return args.snapshot;
  const summary = args.summary;
  const context = { ...args.snapshot.context };

  if (summary) {
    if (node.phase === "plan") {
      context.planSummary = summary;
      context.planSource = args.planSource ?? {
        kind: "message",
        ref: `workflow:${args.snapshot.runId}:${node.id}`,
        summary,
        phase: "plan",
        boundAt: new Date().toISOString(),
      };
    } else if (node.phase === "review") {
      context.reviewSummary = summary;
    } else if (node.phase === "debate") {
      context.debateSummary = summary;
      context.planSummary = summary;
      context.planSource = args.planSource ?? {
        kind: "degraded_debate",
        ref: `workflow:${args.snapshot.runId}:${node.id}`,
        summary,
        phase: "debate",
        boundAt: new Date().toISOString(),
      };
    } else if (node.phase === "verify") {
      context.verificationSummary = summary;
      // 阶段3：把人类可读的对账摘要塞进 context，普通用户 UI 默认折叠时直接显示这一行
      if (args.verification) {
        context.lastVerificationSummary = args.verification.humanSummary;
      }
    }
  }

  const next = updateNode(args.snapshot, node.id, {
    status: "done",
    outputs: {
      ...(node.outputs ?? {}),
      ...(summary ? { summary } : {}),
      ...(args.artifactIds ? { artifactIds: args.artifactIds } : {}),
      ...(args.toolExecutionIds ? { toolExecutionIds: args.toolExecutionIds } : {}),
      ...(args.evidenceIds && args.evidenceIds.length > 0 ? { evidenceIds: args.evidenceIds } : {}),
      ...(args.verification ? { verification: args.verification } : {}),
    },
  });

  return {
    ...next,
    context,
    status: "waiting_user",
    nextActions: defaultNextActionsForPhase(node.phase),
    pendingDecision: defaultNextActionsForPhase(node.phase).length > 0
      ? {
          nodeId: node.id,
          kind: "pick_next_step",
          choices: defaultNextActionsForPhase(node.phase).map((action) => action.id),
        }
      : undefined,
  };
}

/**
 * Harness 工程实施计划阶段1 —— 节点验收未通过时的落库路径。
 * 跟 completeCurrentWorkflowNode 对称，但节点状态标 "failed" 而不是 "done"，
 * 不推进 nextActions/pendingDecision（不能让用户以为可以选"下一步"）。
 * 调用方（stream-finalization.ts）先跑 verifyNodeOutcome，只有 outcome.status !== "passed"
 * 时才走这条路径；needs_user（用户拒绝权限/主动取消）不应该调这个函数——那种情况节点
 * 保持原状即可，不是"验收失败"。
 */
export function failCurrentWorkflowNode(args: {
  snapshot: WorkflowSnapshot;
  outcome: NodeOutcome;
}): WorkflowSnapshot {
  const node = args.snapshot.nodes.find((n) => n.id === args.snapshot.currentNodeId);
  if (!node) return args.snapshot;

  const next = updateNode(args.snapshot, node.id, {
    status: "failed",
    outputs: {
      ...(node.outputs ?? {}),
      summary: args.outcome.summary,
      ...(args.outcome.artifactIds.length > 0 ? { artifactIds: args.outcome.artifactIds } : {}),
      ...(args.outcome.toolExecutionIds.length > 0 ? { toolExecutionIds: args.outcome.toolExecutionIds } : {}),
      // 阶段3：NodeOutcome 已预留 evidenceIds 字段，透传即可（不破接口）。
      ...(args.outcome.evidenceIds.length > 0 ? { evidenceIds: args.outcome.evidenceIds } : {}),
    },
  });

  return {
    ...next,
    context: {
      ...args.snapshot.context,
      // 阶段3：失败也把失败原因里挂的 evidence id 落到 context.lastVerificationSummary
      // （同一字段，UI 复用），便于用户在 UI 里直接看到"缺哪条证据"。
      lastVerificationSummary: args.outcome.summary,
    },
    status: "waiting_user",
    nextActions: [],
    pendingDecision: undefined,
  };
}

/**
 * Harness 工程实施计划阶段1 —— verify 验收 outcome.status === "retryable" 时的落库路径。
 * 跟 failCurrentWorkflowNode 不同：不是终态锁死，而是把 verify 节点打回 pending、
 * 把 currentNodeId 切回 execute 节点等待下一轮修复，同时把 repairAttempts 计数 +1
 * （持久化在 snapshot_json 里，重启后从这个计数继续算，不会无限重试）。
 * 调用方（stream-finalization.ts）只在 outcome.status === "retryable" 时调用这个函数；
 * 达到 node-verifier.ts 的 MAX_REPAIR_ATTEMPTS 上限后 outcome.status 会变成 "blocked"，
 * 那种情况走 failCurrentWorkflowNode 锁死，不再调这里。
 */
export function repairCurrentWorkflowNode(args: {
  snapshot: WorkflowSnapshot;
  outcome: NodeOutcome;
}): WorkflowSnapshot {
  const verifyNode = args.snapshot.nodes.find((n) => n.id === args.snapshot.currentNodeId);
  if (!verifyNode) return args.snapshot;

  const withRepairCount = updateNode(args.snapshot, verifyNode.id, {
    status: "pending",
    repairAttempts: (verifyNode.repairAttempts ?? 0) + 1,
    outputs: { ...(verifyNode.outputs ?? {}), summary: args.outcome.summary },
  });

  const executeNode = withRepairCount.nodes.find((n) => n.phase === "execute");
  if (!executeNode) {
    return { ...withRepairCount, status: "waiting_user", nextActions: [], pendingDecision: undefined };
  }

  return {
    ...withRepairCount,
    currentNodeId: executeNode.id,
    nodes: withRepairCount.nodes.map((n) => (n.id === executeNode.id ? { ...n, status: "ready" } : n)),
    status: "running",
    nextActions: [],
    pendingDecision: undefined,
  };
}

export function attachPlanSourceToWorkflow(args: {
  snapshot: WorkflowSnapshot;
  summary: string;
  source: WorkflowPlanSource;
}): WorkflowSnapshot {
  return {
    ...args.snapshot,
    context: {
      ...args.snapshot.context,
      planSummary: args.summary,
      planSource: args.source,
    },
  };
}

export function attachActiveSkillToWorkflow(args: {
  snapshot: WorkflowSnapshot;
  skill: WorkflowActiveSkill;
}): WorkflowSnapshot {
  return {
    ...args.snapshot,
    context: {
      ...args.snapshot.context,
      activeSkill: args.skill,
    },
  };
}

export function applyTurnIntentDecision(args: {
  snapshot: WorkflowSnapshot;
  decision: TurnIntentDecision;
}): WorkflowSnapshot {
  const { snapshot, decision } = args;
  const intent = decision.patch ? { ...snapshot.intent, ...decision.patch } : snapshot.intent;

  if (decision.action === "pause_run") {
    return { ...snapshot, intent, status: "paused" };
  }

  if (decision.action === "cancel_run") {
    return { ...snapshot, intent, status: "cancelled", pendingDecision: undefined, nextActions: [] };
  }

  if (decision.action === "reject_node") {
    const current = snapshot.nodes.find((node) => node.id === snapshot.currentNodeId);
    if (!current) return { ...snapshot, intent };
    return {
      ...updateNode(snapshot, current.id, { status: "waiting_user" }),
      intent,
      status: "waiting_user",
      pendingDecision: {
        nodeId: current.id,
        kind: "resolve_ambiguity",
        choices: ["modify_run", "restart_phase"],
      },
    };
  }

  if (decision.action === "approve_node" || decision.patch?.executionMode === "execute_directly") {
    return {
      ...setCurrentPhase({ ...snapshot, intent, status: "running", pendingDecision: undefined }, "execute"),
      nextActions: [],
    };
  }

  if (decision.patch?.reviewRequested) {
    return {
      ...setCurrentPhase({ ...snapshot, intent, status: "running", pendingDecision: undefined }, "review"),
      nextActions: [],
    };
  }

  if (decision.patch?.debateRequested) {
    return {
      ...setCurrentPhase({ ...snapshot, intent, status: "running", pendingDecision: undefined }, "debate"),
      nextActions: [],
    };
  }

  if (decision.patch?.verificationRequired && decision.action === "continue_run") {
    return {
      ...setCurrentPhase({ ...snapshot, intent, status: "running", pendingDecision: undefined }, "verify"),
      nextActions: [],
    };
  }

  if (decision.action === "continue_run") {
    if (snapshot.nextActions.length === 1) {
      return {
        ...setCurrentPhase({ ...snapshot, intent, status: "running", pendingDecision: undefined }, snapshot.nextActions[0]!.targetPhase),
        nextActions: [],
      };
    }
    return {
      ...snapshot,
      intent,
      status: "waiting_user",
      pendingDecision: snapshot.nextActions.length > 1
        ? {
            nodeId: snapshot.currentNodeId ?? "workflow",
            kind: "pick_next_step",
            choices: snapshot.nextActions.map((a) => a.id),
          }
        : snapshot.pendingDecision,
    };
  }

  return { ...snapshot, intent };
}
