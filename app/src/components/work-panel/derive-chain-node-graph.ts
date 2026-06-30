import type { ModelListItem } from "@/lib/api";
import {
  ROLE_IDS,
  deriveChainProgress,
  type OrchestrationState,
  type RoleId,
} from "@/lib/llm/orchestrator";
import type { WorkflowNode, WorkflowSnapshot } from "@/lib/workflow/types";

export type ChainNodeVisualStatus = "planned" | "active" | "running" | "done" | "skipped" | "aborted";
export type ChainNodeRole = RoleId | "debate";

export interface ChainNodeView {
  id: string;
  role: ChainNodeRole;
  stepName: string;
  title: string;
  modelId: string | null;
  modelName: string;
  status: ChainNodeVisualStatus;
  pinned: boolean;
  locked?: boolean;
}

export interface ChainNodeGraphView {
  nodes: ChainNodeView[];
}

const ROLE_STEP_NAME: Record<ChainNodeRole, string> = {
  leader: "主对话",
  architect: "计划方案",
  frontend: "前端工程师执行",
  backend: "后端工程师执行",
  runner: "运行检查",
  tester: "测试",
  reviewer: "最终审查",
  security: "安全审查",
  debate: "模型博弈",
};

const CHAIN_ROLE_ORDER: ChainNodeRole[] = [
  "leader",
  "architect",
  "debate",
  "backend",
  "frontend",
  "runner",
  "tester",
  "reviewer",
  "security",
];

function modelName(modelId: string | null, models: ModelListItem[], fallback: string): string {
  if (!modelId) return fallback;
  const model = models.find((m) => m.id === modelId);
  return model?.displayName || model?.name || modelId;
}

function byStableRoleOrder(a: ChainNodeView, b: ChainNodeView): number {
  return CHAIN_ROLE_ORDER.indexOf(a.role) - CHAIN_ROLE_ORDER.indexOf(b.role);
}

function debateNodeStatus(snapshot: WorkflowSnapshot, node: WorkflowNode): ChainNodeVisualStatus {
  if (node.status === "done") return "done";
  if (node.status === "failed") return "aborted";
  if (node.status === "skipped") return "skipped";
  if (snapshot.currentNodeId === node.id || node.status === "ready" || node.status === "running") return "active";
  return "planned";
}

function deriveDebateNode(snapshot: WorkflowSnapshot | null): ChainNodeView | null {
  if (!snapshot) return null;
  const node = snapshot.nodes.find((n) => n.phase === "debate") ?? null;
  if (!node) return null;
  const shouldShow =
    snapshot.intent.debateRequested ||
    snapshot.currentNodeId === node.id ||
    node.status !== "pending";
  if (!shouldShow) return null;

  return {
    id: "workflow-debate",
    role: "debate",
    stepName: ROLE_STEP_NAME.debate,
    title: node.title,
    modelId: null,
    modelName: "dynamic",
    status: debateNodeStatus(snapshot, node),
    pinned: false,
    locked: true,
  };
}

export function deriveChainNodeGraph(args: {
  orchestration: OrchestrationState | null;
  workflowSnapshot?: WorkflowSnapshot | null;
  selectedModelId: string;
  selectedModelName: string;
  availableModels: ModelListItem[];
  chainRunning: boolean;
  chainExecutedRoles: RoleId[];
  chainSkippedRoles: RoleId[];
  chainAbortedRole: RoleId | null;
}): ChainNodeGraphView {
  const leaderNode: ChainNodeView = {
    id: "main-chat",
    role: "leader",
    stepName: ROLE_STEP_NAME.leader,
    title: "当前主对话",
    modelId: args.selectedModelId || null,
    modelName: args.selectedModelName || modelName(args.selectedModelId || null, args.availableModels, "未选择模型"),
    status: args.orchestration?.currentNodeId ? "done" : args.chainRunning ? "running" : "active",
    pinned: false,
  };
  const virtualDebateNode = deriveDebateNode(args.workflowSnapshot ?? null);

  if (!args.orchestration || args.orchestration.nodes.length === 0) {
    return { nodes: virtualDebateNode ? [leaderNode, virtualDebateNode] : [leaderNode] };
  }

  const executed = new Set(args.chainExecutedRoles);
  const skipped = new Set(args.chainSkippedRoles);
  const progress = deriveChainProgress({
    chainPlan: args.orchestration.chainPlan ?? [],
    executedRoles: args.chainExecutedRoles,
    skippedRoles: args.chainSkippedRoles,
    abortedRole: args.chainAbortedRole,
  });
  const current = args.orchestration.nodes.find((n) => n.id === args.orchestration?.currentNodeId) ?? null;

  const views = args.orchestration.nodes
    .filter((node) => node.role !== "leader")
    .map<ChainNodeView>((node) => {
      let status: ChainNodeVisualStatus;
      if (node.role === args.chainAbortedRole) status = "aborted";
      else if (skipped.has(node.role)) status = "skipped";
      else if (args.chainRunning && progress.executingRole === node.role) status = "running";
      else if (executed.has(node.role) || node.status === "done") status = "done";
      else if (node.id === args.orchestration?.currentNodeId || current?.role === node.role) status = "active";
      else status = "planned";

      return {
        id: node.id,
        role: node.role,
        stepName: ROLE_STEP_NAME[node.role] ?? node.role,
        title: node.title,
        modelId: node.modelId,
        modelName: modelName(node.modelId, args.availableModels, "未绑定模型"),
        status,
        pinned: node.pinned,
      };
    })
    .sort(byStableRoleOrder);

  const nodes = virtualDebateNode ? [leaderNode, ...views, virtualDebateNode].sort(byStableRoleOrder) : [leaderNode, ...views];
  return { nodes };
}

export function isKnownRole(role: string): role is RoleId {
  return (ROLE_IDS as readonly string[]).includes(role);
}
