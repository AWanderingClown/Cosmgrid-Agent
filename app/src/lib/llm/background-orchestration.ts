import { getRoleBindingsForConversation, usageEvents } from "@/lib/db";
import type { CredentialListItem, ModelListItem } from "@/lib/api";
import { resolveAuxiliaryModel } from "./auxiliary-model";
import { buildRolePerformanceScoresFromUsageRows } from "./model-performance-scoring";
import {
  computeChain,
  diffOrchestration,
  planNodes,
  resolveOrchestration,
  shouldSkipOrchestrationUpdate,
  type OrchestrationChange,
  type OrchestrationState,
  type OrchestrationTurn,
  type RoleId,
  withChainPlan,
} from "./orchestrator";

export interface BackgroundOrchestrationResult {
  next: OrchestrationState;
  nextWithChain: OrchestrationState;
  change: OrchestrationChange;
  reason: string;
  chainPlan: RoleId[];
  effectiveChainBindings: Map<RoleId, string>;
}

export async function planBackgroundOrchestration(args: {
  conversationId: string;
  history: OrchestrationTurn[];
  previousState: OrchestrationState | null;
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  getApiKey: (credentialId: string) => Promise<string | null>;
}): Promise<BackgroundOrchestrationResult | null> {
  const resolved = await resolveAuxiliaryModel({
    availableModels: args.availableModels,
    credentials: args.credentials,
    getApiKey: args.getApiKey,
  });
  if (!resolved) return null;

  const plan = await planNodes(resolved.model, args.history, args.previousState);
  const roleBindings = await getRoleBindingsForConversation(args.conversationId);
  const rolePerformanceScores = await usageEvents.list()
    .then(buildRolePerformanceScoresFromUsageRows)
    .catch(() => undefined);
  const next = resolveOrchestration(
    plan,
    args.availableModels,
    args.previousState,
    roleBindings,
    rolePerformanceScores,
  );
  const chainPlan = computeChain(plan);
  const nextWithChain = withChainPlan(next, chainPlan);
  if (shouldSkipOrchestrationUpdate(args.previousState, nextWithChain, chainPlan)) return null;

  const change = diffOrchestration(args.previousState, next);
  const effectiveChainBindings = new Map(roleBindings);
  for (const node of nextWithChain.nodes) {
    if (node.modelId) effectiveChainBindings.set(node.role, node.modelId);
  }

  return {
    next,
    nextWithChain,
    change,
    reason: plan.reason,
    chainPlan,
    effectiveChainBindings,
  };
}
