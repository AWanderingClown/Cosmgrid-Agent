import type { CredentialListItem, ModelListItem } from "@/lib/api";
import { isCliProviderType } from "@/lib/llm/cli-protocol";
import { rankFallbackModels } from "@/lib/llm/model-capabilities";
import { toModelEndpoint, type ModelEndpoint } from "@/lib/llm/chat-fallback";
import type { Attachment } from "@/lib/llm/attachments";

export async function buildMainChatModelChain(args: {
  primaryModel: ModelListItem;
  primaryCredential: CredentialListItem;
  primaryApiKey: string;
  primaryIsCli: boolean;
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  attachments?: Attachment[];
  effectiveWorkspace: string | null;
  getApiKey: (credentialId: string) => Promise<string | null>;
  stopIfAborted: () => boolean;
  toEndpoint?: typeof toModelEndpoint;
}): Promise<ModelEndpoint[]> {
  const toEndpoint = args.toEndpoint ?? toModelEndpoint;
  const primary = toEndpoint(args.primaryModel, args.primaryCredential, args.primaryApiKey);
  if (args.primaryIsCli && args.effectiveWorkspace) primary.workingDirectory = args.effectiveWorkspace;

  const chain = [primary];
  const hasImageChain = args.attachments?.some((a) => a.kind === "image") ?? false;

  for (const cand of rankFallbackModels(args.primaryModel, args.availableModels, "main_chat")) {
    const fbCred = args.credentials.find((c) => c.providerId === cand.providerId);
    if (!fbCred) continue;
    const fbIsCli = isCliProviderType(cand.provider?.type ?? "");
    if (hasImageChain && fbIsCli) continue;

    let fbKey = "";
    if (!fbIsCli) {
      const key = await args.getApiKey(fbCred.id);
      if (args.stopIfAborted()) return chain;
      if (!key) continue;
      fbKey = key;
    }

    try {
      const endpoint = toEndpoint(cand, fbCred, fbKey);
      if (fbIsCli && args.effectiveWorkspace) endpoint.workingDirectory = args.effectiveWorkspace;
      chain.push(endpoint);
    } catch {
      // 备用模型缺 provider 类型等，跳过它，不影响主流程。
    }
  }

  return chain;
}
