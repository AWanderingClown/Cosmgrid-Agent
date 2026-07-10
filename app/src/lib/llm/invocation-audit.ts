import { isCliProviderType } from "./cli-protocol";
import type { LlmErrorCategory } from "./error-classifier";
import type { ModelEndpoint, StreamUsage } from "./chat-fallback-contracts";

export type LlmInvocationStatus = "success" | "error" | "cooldown" | "aborted";
export type LlmProviderKind = "api" | "cli";

export interface LlmInvocationAuditEvent {
  modelId: string;
  modelName: string;
  providerType: string;
  providerKind: LlmProviderKind;
  status: LlmInvocationStatus;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  finishReason?: string;
  errorCategory?: LlmErrorCategory;
  usage?: StreamUsage;
}

export function providerKind(providerType: string): LlmProviderKind {
  return isCliProviderType(providerType) ? "cli" : "api";
}

export function buildLlmInvocationAuditEvent(args: {
  target: ModelEndpoint;
  status: LlmInvocationStatus;
  startedAtMs: number;
  endedAtMs?: number;
  finishReason?: string;
  errorCategory?: LlmErrorCategory;
  usage?: StreamUsage;
}): LlmInvocationAuditEvent {
  const endedAtMs = args.endedAtMs ?? Date.now();
  return {
    modelId: args.target.modelId,
    modelName: args.target.modelName,
    providerType: args.target.providerType,
    providerKind: providerKind(args.target.providerType),
    status: args.status,
    startedAt: new Date(args.startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    latencyMs: Math.max(0, endedAtMs - args.startedAtMs),
    ...(args.finishReason ? { finishReason: args.finishReason } : {}),
    ...(args.errorCategory ? { errorCategory: args.errorCategory } : {}),
    ...(args.usage ? { usage: args.usage } : {}),
  };
}
