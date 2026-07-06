import type { CredentialListItem, ModelListItem } from "@/lib/api";
import type { DebateRoleConfig } from "@/lib/llm/debate-engine";
import { isCliProviderType } from "@/lib/llm/cli-protocol";
import { rankFallbackModels } from "@/lib/llm/model-capabilities";

export async function buildDebateParticipants(args: {
  primaryModel: ModelListItem;
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  effectiveWorkspace: string | null;
  getApiKey: (credentialId: string) => Promise<string | null>;
  maxParticipants?: number;
}): Promise<DebateRoleConfig[]> {
  const limit = args.maxParticipants ?? 4;
  const ordered = [
    args.primaryModel,
    ...rankFallbackModels(args.primaryModel, args.availableModels, "planning", Math.max(1, limit - 1)),
  ];
  const seen = new Set<string>();
  const participants: DebateRoleConfig[] = [];

  for (const candidate of ordered) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
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
