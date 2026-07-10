// Provider 工厂：把 provider 类型映射到 Vercel AI SDK 的 languageModel 实例
// v0.3：去掉 node:crypto，改用浏览器 crypto.subtle（WebView 支持）

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { resolveSseFirstByteTimeoutMs } from "./model-limits";
import { withSseChunkTimeout } from "./sse-chunk-timeout";

export type LanguageModel = ReturnType<ReturnType<typeof createAnthropic>>;
export type LanguageModelFactory = (
  modelName: string,
  apiKey: string,
  baseUrl?: string,
) => LanguageModel;

interface ProviderRegistryEntry {
  factory: LanguageModelFactory;
}

const REGISTRY = new Map<string, ProviderRegistryEntry>();

REGISTRY.set("anthropic", {
  factory: (modelName, apiKey, baseUrl) => {
    const timeoutFetch = withSseChunkTimeout(fetch, {
      firstByteTimeoutMs: resolveSseFirstByteTimeoutMs(modelName),
    });
    const provider = createAnthropic({ apiKey, fetch: timeoutFetch, ...(baseUrl && { baseURL: baseUrl }) });
    return provider(modelName);
  },
});

REGISTRY.set("openai", {
  factory: (modelName, apiKey, baseUrl) => {
    const timeoutFetch = withSseChunkTimeout(fetch, {
      firstByteTimeoutMs: resolveSseFirstByteTimeoutMs(modelName),
    });
    const provider = createOpenAI({ apiKey, fetch: timeoutFetch, ...(baseUrl && { baseURL: baseUrl }) });
    // 必须用 .chat() 走 /chat/completions：@ai-sdk/openai 3.x 的 provider(id) 默认走 Responses API
    // (/responses)，而绝大多数 OpenAI 兼容服务（含 OpenAI 自家旧模型、第三方）只实现 /chat/completions。
    return provider.chat(modelName);
  },
});

REGISTRY.set("google", {
  factory: (modelName, apiKey, baseUrl) => {
    const timeoutFetch = withSseChunkTimeout(fetch, {
      firstByteTimeoutMs: resolveSseFirstByteTimeoutMs(modelName),
    });
    const provider = createGoogleGenerativeAI({ apiKey, fetch: timeoutFetch, ...(baseUrl && { baseURL: baseUrl }) });
    return provider(modelName);
  },
});

// v0.4.4：openai-compatible 接 GLM / DeepSeek / Qwen / Kimi / 自定义 endpoint
// 协议走 OpenAI Chat Completions + 流式 SSE，Vercel AI SDK 的 createOpenAI 配 baseUrl 即可
// 用户在 ApiCredential.baseUrl 填目标 endpoint（如 https://api.deepseek.com/v1）
REGISTRY.set("openai-compatible", {
  factory: (modelName, apiKey, baseUrl) => {
    if (!baseUrl) {
      throw new Error("openai-compatible provider requires a baseUrl on the credential (e.g. https://api.deepseek.com/v1)");
    }
    const timeoutFetch = withSseChunkTimeout(fetch, {
      firstByteTimeoutMs: resolveSseFirstByteTimeoutMs(modelName),
    });
    const provider = createOpenAI({ apiKey, baseURL: baseUrl, fetch: timeoutFetch });
    // DeepSeek / GLM / Qwen / Kimi 等只实现 /chat/completions，没有 /responses。
    // 必须 .chat()，否则 provider(id) 默认发到 /responses → 这些服务一律 404（误报"模型不存在"）。
    return provider.chat(modelName);
  },
});

// LRU 缓存（用 apiKey 后 8 位做 cache key，不用 node:crypto）
const CACHE_MAX_SIZE = 100;
const languageModelCache = new Map<string, ReturnType<LanguageModelFactory>>();

function getCacheKey(type: string, modelName: string, apiKey: string): string {
  const keyTail = apiKey.slice(-8);
  return `${type}/${modelName}/${keyTail}`;
}

function getFromCache(key: string): ReturnType<LanguageModelFactory> | undefined {
  const value = languageModelCache.get(key);
  if (value) {
    languageModelCache.delete(key);
    languageModelCache.set(key, value);
  }
  return value;
}

function setCache(key: string, value: ReturnType<LanguageModelFactory>): void {
  if (languageModelCache.size >= CACHE_MAX_SIZE) {
    const firstKey = languageModelCache.keys().next().value;
    if (firstKey !== undefined) languageModelCache.delete(firstKey);
  }
  languageModelCache.set(key, value);
}

export function isProviderRegistered(type: string): boolean {
  return REGISTRY.has(type);
}

export function listRegisteredProviders(): string[] {
  return Array.from(REGISTRY.keys());
}

export function getLanguageModel(
  providerType: string,
  modelName: string,
  apiKey: string,
  baseUrl?: string,
): ReturnType<LanguageModelFactory> {
  const entry = REGISTRY.get(providerType);
  if (!entry) {
    throw new Error(
      `Unknown provider type: "${providerType}". Registered: ${listRegisteredProviders().join(", ")}`,
    );
  }

  const cacheKey = getCacheKey(providerType, modelName, apiKey);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const lm = entry.factory(modelName, apiKey, baseUrl);
  setCache(cacheKey, lm);
  return lm;
}
