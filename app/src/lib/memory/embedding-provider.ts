import { embed } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { apiCredentials } from "@/lib/db";
import { getApiKey } from "@/lib/keystore";
import { getMemoryEmbeddingSetting } from "@/lib/app-settings";
import { keywordEmbeddingProvider, type EmbeddingProvider } from "@/lib/llm/embedding";

function remoteProviderName(credentialId: string, modelName: string): string {
  return `remote-openai-embedding:${credentialId}:${modelName}`;
}

function createRemoteOpenAIEmbeddingProvider(options: {
  credentialId: string;
  modelName: string;
  apiKey: string;
  baseUrl?: string;
}): EmbeddingProvider {
  const provider = createOpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl && { baseURL: options.baseUrl }),
  });
  return {
    name: remoteProviderName(options.credentialId, options.modelName),
    dim: 0,
    supportsHotBackfill: false,
    async embed(text: string): Promise<number[]> {
      const result = await embed({
        model: provider.embeddingModel(options.modelName),
        value: text,
      });
      return result.embedding;
    },
  };
}

/**
 * 项目记忆专用 embedding provider。
 * 默认走本地关键词哈希；只有设置页显式启用远程 embedding 且凭据可用时才调用外部接口。
 */
export async function getProjectMemoryEmbeddingProvider(): Promise<EmbeddingProvider> {
  const setting = getMemoryEmbeddingSetting();
  if (setting.mode !== "remote" || !setting.credentialId) return keywordEmbeddingProvider;

  const credential = await apiCredentials.getById(setting.credentialId).catch(() => null);
  const providerType = credential?.provider?.type ?? "";
  if (!credential || !credential.enabled || !["openai", "openai-compatible"].includes(providerType)) {
    return keywordEmbeddingProvider;
  }

  const apiKey = await getApiKey(credential.id).catch(() => null);
  if (!apiKey) return keywordEmbeddingProvider;

  return createRemoteOpenAIEmbeddingProvider({
    credentialId: credential.id,
    modelName: setting.modelName,
    apiKey,
    baseUrl: credential.baseUrl || undefined,
  });
}
