import { defaultNextActionsForPhase } from "./code-task-template";
import type { TurnIntentDecision, WorkflowNode, WorkflowPhase, WorkflowSnapshot } from "./types";

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
  artifactIds?: string[];
  toolExecutionIds?: string[];
}): WorkflowSnapshot {
  const node = args.snapshot.nodes.find((n) => n.id === args.snapshot.currentNodeId);
  if (!node) return args.snapshot;
  const next = updateNode(args.snapshot, node.id, {
    status: "done",
    outputs: {
      ...(node.outputs ?? {}),
      ...(args.summary ? { summary: args.summary } : {}),
      ...(args.artifactIds ? { artifactIds: args.artifactIds } : {}),
      ...(args.toolExecutionIds ? { toolExecutionIds: args.toolExecutionIds } : {}),
    },
  });

  return {
    ...next,
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
