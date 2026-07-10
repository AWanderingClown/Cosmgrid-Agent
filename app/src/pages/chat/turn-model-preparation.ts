import type { CredentialListItem, ModelListItem } from "@/lib/api";
import { resolveAuxiliaryModel } from "@/lib/llm/auxiliary-model";
import { isCliProviderType } from "@/lib/llm/cli-protocol";
import { getLanguageModel } from "@/lib/llm/provider-factory";

interface PrepareTurnModelsOptions {
  model: ModelListItem;
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  getApiKey: (credentialId: string) => Promise<string | null>;
  isAborted?: () => boolean;
}

type PreparedTurnModels = {
  ok: true;
  credential: CredentialListItem;
  primaryIsCli: boolean;
  apiKey: string;
  intentJudgeModel: ReturnType<typeof getLanguageModel> | null;
  auxiliaryJudgeModel: Awaited<ReturnType<typeof resolveAuxiliaryModel>>;
};

type TurnModelPreparationFailure = {
  ok: false;
  reason: "missing-credential" | "missing-api-key" | "aborted";
};

export async function prepareTurnModels(
  options: PrepareTurnModelsOptions,
): Promise<PreparedTurnModels | TurnModelPreparationFailure> {
  const credential = options.credentials.find(
    (candidate) => candidate.providerId === options.model.providerId,
  );
  if (!credential) return { ok: false, reason: "missing-credential" };

  const primaryIsCli = isCliProviderType(options.model.provider?.type ?? "");
  const apiKey = primaryIsCli
    ? ""
    : ((await options.getApiKey(credential.id)) ?? "");
  if (options.isAborted?.()) return { ok: false, reason: "aborted" };
  if (!primaryIsCli && !apiKey) {
    return { ok: false, reason: "missing-api-key" };
  }

  let intentJudgeModel: ReturnType<typeof getLanguageModel> | null = null;
  if (!primaryIsCli && options.model.provider?.type) {
    try {
      intentJudgeModel = getLanguageModel(
        options.model.provider.type,
        options.model.name,
        apiKey,
        credential.baseUrl,
      );
    } catch {
      intentJudgeModel = null;
    }
  }

  const auxiliaryJudgeModel = await resolveAuxiliaryModel({
    availableModels: options.availableModels,
    credentials: options.credentials,
    getApiKey: options.getApiKey,
  });

  return {
    ok: true,
    credential,
    primaryIsCli,
    apiKey,
    intentJudgeModel,
    auxiliaryJudgeModel,
  };
}
