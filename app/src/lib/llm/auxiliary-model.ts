import type { CredentialListItem, ModelListItem } from "@/lib/api";
import { isCliProviderType } from "./cli-protocol";
import { pickOrchestratorModel } from "./orchestrator";
import { getLanguageModel, type LanguageModel } from "./provider-factory";

interface AuxiliaryCandidate {
  model: ModelListItem;
  credential: CredentialListItem;
}

export interface AuxiliaryModelResolution {
  model: LanguageModel;
  modelId: string;
  modelName: string;
  providerType: string;
}

function listApiCandidates(
  availableModels: ModelListItem[],
  credentials: CredentialListItem[],
): AuxiliaryCandidate[] {
  return availableModels
    .filter((model) => model.provider && !isCliProviderType(model.provider.type))
    .map((model) => ({
      model,
      credential: credentials.find((cred) => cred.providerId === model.providerId) ?? null,
    }))
    .filter((row): row is AuxiliaryCandidate => row.credential !== null);
}

async function hydrateCandidate(
  candidate: AuxiliaryCandidate | null,
  getApiKey: (credentialId: string) => Promise<string | null>,
): Promise<AuxiliaryModelResolution | null> {
  if (!candidate || !candidate.model.provider) return null;
  const apiKey = await getApiKey(candidate.credential.id);
  if (!apiKey) return null;
  try {
    return {
      model: getLanguageModel(
        candidate.model.provider.type,
        candidate.model.name,
        apiKey,
        candidate.credential.baseUrl,
      ),
      modelId: candidate.model.id,
      modelName: candidate.model.name,
      providerType: candidate.model.provider.type,
    };
  } catch {
    return null;
  }
}

export async function resolveAuxiliaryModel(args: {
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  getApiKey: (credentialId: string) => Promise<string | null>;
  preferredModelId?: string | null;
}): Promise<AuxiliaryModelResolution | null> {
  const candidates = listApiCandidates(args.availableModels, args.credentials);
  if (candidates.length === 0) return null;

  if (args.preferredModelId) {
    const preferred = candidates.find((row) => row.model.id === args.preferredModelId) ?? null;
    const hydratedPreferred = await hydrateCandidate(preferred, args.getApiKey);
    if (hydratedPreferred) return hydratedPreferred;
  }

  const ordered: AuxiliaryCandidate[] = [];
  const remaining = [...candidates];
  while (remaining.length > 0) {
    const picked = pickOrchestratorModel(remaining.map((row) => row.model));
    if (!picked) break;
    const idx = remaining.findIndex((row) => row.model.id === picked.id);
    if (idx === -1) break;
    ordered.push(remaining[idx]!);
    remaining.splice(idx, 1);
  }

  for (const candidate of ordered) {
    const hydrated = await hydrateCandidate(candidate, args.getApiKey);
    if (hydrated) return hydrated;
  }
  return null;
}
