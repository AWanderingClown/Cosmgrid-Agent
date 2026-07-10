import type { CredentialListItem, ModelListItem } from "@/lib/api";
import type { DebateRoleConfig } from "./debate-engine";
import { isCliProviderType } from "./cli-protocol";
import { hydrateModelCooldowns, isInCooldown } from "./model-cooldown";
import { rankFallbackModels } from "./model-capabilities";

function debateProviderPriority(model: ModelListItem): number {
  const type = model.provider?.type ?? "";
  if (type === "claude-cli") return 0;
  if (type === "codex-cli") return 1;
  if (isCliProviderType(type)) return 2;
  return 3;
}

export async function buildDebateParticipants(args: {
  primaryModel: ModelListItem;
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  effectiveWorkspace: string | null;
  getApiKey: (credentialId: string) => Promise<string | null>;
  maxParticipants?: number;
}): Promise<DebateRoleConfig[]> {
  const limit = args.maxParticipants ?? 4;
  const fallbackRank = new Map(
    rankFallbackModels(args.primaryModel, args.availableModels, "planning", args.availableModels.length)
      .map((model, index) => [model.id, index]),
  );
  const ordered = [...args.availableModels].sort((a, b) => {
    const providerDelta = debateProviderPriority(a) - debateProviderPriority(b);
    if (providerDelta !== 0) return providerDelta;
    if (a.id === args.primaryModel.id) return -1;
    if (b.id === args.primaryModel.id) return 1;
    return (fallbackRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (fallbackRank.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  });
  await hydrateModelCooldowns(ordered.map((model) => model.id)).catch(() => {});
  const seen = new Set<string>();
  const participants: DebateRoleConfig[] = [];

  for (const candidate of ordered) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    if (isInCooldown(candidate.id)) continue;
    const cred = args.credentials.find((c) => c.providerId === candidate.providerId);
    if (!cred) continue;
    const providerType = candidate.provider?.type ?? "";
    if (!providerType) continue;
    const isCli = isCliProviderType(providerType);
    const key = isCli ? "" : await args.getApiKey(cred.id);
    if (!isCli && !key) continue;
    participants.push({
      role: `participant_${participants.length + 1}`,
      modelId: candidate.id,
      modelName: candidate.name,
      providerType,
      providerId: candidate.providerId,
      apiCredentialId: cred.id,
      apiKey: key ?? "",
      ...(cred.baseUrl ? { baseUrl: cred.baseUrl } : {}),
      ...(isCli && args.effectiveWorkspace ? { workingDirectory: args.effectiveWorkspace } : {}),
    });
    if (participants.length >= limit) break;
  }

  return participants;
}
