import type { CredentialListItem, ModelListItem } from "@/lib/api";
import { isCliProviderType } from "./cli-protocol";
import { toModelEndpoint, type ModelEndpoint } from "./chat-fallback";

export async function buildApiModelEndpoints(args: {
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  getApiKey: (credentialId: string) => Promise<string | null>;
}): Promise<ModelEndpoint[]> {
  const endpoints: ModelEndpoint[] = [];
  for (const model of args.availableModels) {
    if (!model.provider || isCliProviderType(model.provider.type)) continue;
    const credential = args.credentials.find((cred) => cred.providerId === model.providerId);
    if (!credential) continue;
    const apiKey = await args.getApiKey(credential.id);
    if (!apiKey) continue;
    endpoints.push(toModelEndpoint(model, credential, apiKey));
  }
  return endpoints;
}
