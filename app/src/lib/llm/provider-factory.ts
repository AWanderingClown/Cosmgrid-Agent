// Provider 工厂：把 provider 类型映射到 Vercel AI SDK 的 languageModel 实例
// v0.3：去掉 node:crypto，改用浏览器 crypto.subtle（WebView 支持）

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

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

export function registerProvider(type: string, factory: LanguageModelFactory): void {
  REGISTRY.set(type, { factory });
}

REGISTRY.set("anthropic", {
  factory: (modelName, apiKey, baseUrl) => {
    const provider = createAnthropic({ apiKey, ...(baseUrl && { baseURL: baseUrl }) });
    return provider(modelName);
  },
});

REGISTRY.set("openai", {
  factory: (modelName, apiKey, baseUrl) => {
    const provider = createOpenAI({ apiKey, ...(baseUrl && { baseURL: baseUrl }) });
    return provider(modelName);
  },
});

REGISTRY.set("google", {
  factory: (modelName, apiKey, baseUrl) => {
    const provider = createGoogleGenerativeAI({ apiKey, ...(baseUrl && { baseURL: baseUrl }) });
    return provider(modelName);
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
      `未知 provider 类型: "${providerType}"。已注册: ${listRegisteredProviders().join(", ")}`,
    );
  }

  const cacheKey = getCacheKey(providerType, modelName, apiKey);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const lm = entry.factory(modelName, apiKey, baseUrl);
  setCache(cacheKey, lm);
  return lm;
}

export function clearLanguageModelCache(): void {
  languageModelCache.clear();
}
