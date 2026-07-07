import {
  modelPriceCatalog,
  priceSyncStatus,
  type ModelPriceCatalogEntry,
} from "../db";
import { MODEL_PRICES, type ModelPrice } from "./model-prices";

export const BUILTIN_PRICE_CATALOG_VERSION = "builtin-2026-06-28";
export const REMOTE_PRICE_CATALOG_SOURCE = "models.dev";
export const REMOTE_PRICE_CATALOG_URL = "https://models.dev/api.json";

export interface ResolvedModelPrice extends ModelPrice {
  catalogId: string | null;
  version: string;
  source: "builtin" | "remote" | "manual";
  sourceUrl: string | null;
}

export interface SyncModelPricesResult {
  ok: boolean;
  version: string | null;
  inserted: number;
  error: string | null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function entryToResolvedPrice(entry: ModelPriceCatalogEntry): ResolvedModelPrice {
  return {
    catalogId: entry.id,
    input: entry.inputPer1m,
    output: entry.outputPer1m,
    cacheRead: entry.cacheReadPer1m ?? undefined,
    cacheWrite: entry.cacheWritePer1m ?? undefined,
    contextWindow: entry.contextWindow ?? 0,
    version: entry.version,
    source: entry.source,
    sourceUrl: entry.sourceUrl,
  };
}

function builtinPriceToResolvedPrice(modelName: string, price: ModelPrice): ResolvedModelPrice {
  return {
    catalogId: null,
    ...price,
    contextWindow: price.contextWindow,
    version: BUILTIN_PRICE_CATALOG_VERSION,
    source: "builtin",
    sourceUrl: `builtin:${modelName}`,
  };
}

export async function lookupPriceFromCatalog(
  modelName: string,
  providerType?: string | null,
): Promise<ResolvedModelPrice | null> {
  const row = await modelPriceCatalog.lookupActive(modelName, providerType ?? null);
  if (row) {
    return entryToResolvedPrice(row);
  }

  const builtin = MODEL_PRICES[modelName] ?? MODEL_PRICES[Object.keys(MODEL_PRICES).find((key) => normalize(key) === normalize(modelName)) ?? ""];
  if (!builtin) return null;

  const seeded = await modelPriceCatalog.create({
    modelName,
    providerType: null,
    inputPer1m: builtin.input,
    outputPer1m: builtin.output,
    cacheReadPer1m: builtin.cacheRead ?? null,
    cacheWritePer1m: builtin.cacheWrite ?? null,
    contextWindow: builtin.contextWindow || null,
    source: "builtin",
    sourceUrl: `builtin:${modelName}`,
    version: BUILTIN_PRICE_CATALOG_VERSION,
  }).catch(() => null);
  return seeded ? entryToResolvedPrice(seeded) : builtinPriceToResolvedPrice(modelName, builtin);
}

interface ModelsDevProviderMeta {
  models?: Record<string, ModelsDevModelMeta>;
}

interface ModelsDevModelMeta {
  id?: string;
  limit?: {
    context?: number;
  };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

function providerTypeFromModelsDevId(providerId: string): string | null {
  const normalized = normalize(providerId);
  if (normalized.includes("anthropic")) return "anthropic";
  if (normalized.includes("openai")) return "openai";
  if (normalized.includes("google")) return "google";
  return normalized || null;
}

export function parseRemotePriceCatalog(json: unknown, version: string): Array<{
  modelName: string;
  providerType: string | null;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number | null;
  cacheWritePer1m: number | null;
  contextWindow: number | null;
  source: "remote";
  sourceUrl: string;
  version: string;
}> {
  if (!json || typeof json !== "object") return [];
  const out: Array<{
    modelName: string;
    providerType: string | null;
    inputPer1m: number;
    outputPer1m: number;
    cacheReadPer1m: number | null;
    cacheWritePer1m: number | null;
    contextWindow: number | null;
    source: "remote";
    sourceUrl: string;
    version: string;
  }> = [];

  for (const [providerId, providerMeta] of Object.entries(json as Record<string, ModelsDevProviderMeta>)) {
    const providerType = providerTypeFromModelsDevId(providerId);
    for (const [fullModelId, meta] of Object.entries(providerMeta.models ?? {})) {
      const input = meta.cost?.input;
      const output = meta.cost?.output;
      if (typeof input !== "number" || typeof output !== "number") continue;

      const sourceId = typeof meta.id === "string" && meta.id ? meta.id : fullModelId;
      const slash = sourceId.lastIndexOf("/");
      const modelName = slash >= 0 ? sourceId.slice(slash + 1) : sourceId;
      if (!modelName) continue;

      out.push({
        modelName,
        providerType,
        inputPer1m: input,
        outputPer1m: output,
        cacheReadPer1m: typeof meta.cost?.cache_read === "number" ? meta.cost.cache_read : null,
        cacheWritePer1m: typeof meta.cost?.cache_write === "number" ? meta.cost.cache_write : null,
        contextWindow: typeof meta.limit?.context === "number" ? meta.limit.context : null,
        source: "remote",
        sourceUrl: `${REMOTE_PRICE_CATALOG_URL}#${providerId}/${modelName}`,
        version,
      });
    }
  }

  return out;
}

let syncPromise: Promise<SyncModelPricesResult> | null = null;

export async function syncModelPrices(): Promise<SyncModelPricesResult> {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const attemptedAt = new Date().toISOString();
    const version = `${REMOTE_PRICE_CATALOG_SOURCE}:${attemptedAt}`;
    await priceSyncStatus.upsert({
      source: REMOTE_PRICE_CATALOG_SOURCE,
      sourceUrl: REMOTE_PRICE_CATALOG_URL,
      lastAttemptAt: attemptedAt,
      lastError: null,
    });

    try {
      const res = await fetch(REMOTE_PRICE_CATALOG_URL, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const entries = parseRemotePriceCatalog(await res.json(), version);
      if (entries.length === 0) {
        throw new Error("remote catalog returned no priced models");
      }

      // 残缺响应体检（2026-07-07，用户实测事故 + 备份数据实锤）：今天用户网络（疑似代理）
      // 把 models.dev 的大响应截断成只剩第一个供应商 requesty 的 4 个模型，一整天每次同步都
      // 是这 4 行。replaceSourceEntries 现在是真删除再插入——如果不拦，会拿这 4 行残缺数据把
      // 已有的 4953 行完整价格全删光。两道闸：
      //   1. 绝对下限：models.dev 正常有几千个带价模型，低于 MIN_REMOTE_ENTRIES 必是残缺/异常。
      //   2. 相对下限：已有数据时，新抓的数量若不到现有的一半，判定为残缺，宁可保留旧的。
      // 命中任一条都当失败处理：不替换、保住原有好数据，status 里记明原因。
      const MIN_REMOTE_ENTRIES = 100;
      const existingCount = await modelPriceCatalog.countBySource("remote");
      if (
        entries.length < MIN_REMOTE_ENTRIES ||
        (existingCount > 0 && entries.length < existingCount * 0.5)
      ) {
        throw new Error(
          `remote catalog looks truncated: got ${entries.length} entries` +
            (existingCount > 0 ? ` (already have ${existingCount})` : "") +
            `，疑似网络截断响应，已保留原有价格不做替换`,
        );
      }

      await modelPriceCatalog.replaceSourceEntries("remote", entries);

      await priceSyncStatus.upsert({
        source: REMOTE_PRICE_CATALOG_SOURCE,
        sourceUrl: REMOTE_PRICE_CATALOG_URL,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: attemptedAt,
        lastError: null,
        catalogVersion: version,
      });

      return { ok: true, version, inserted: entries.length, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await priceSyncStatus.upsert({
        source: REMOTE_PRICE_CATALOG_SOURCE,
        sourceUrl: REMOTE_PRICE_CATALOG_URL,
        lastAttemptAt: attemptedAt,
        lastError: message,
      });
      return { ok: false, version: null, inserted: 0, error: message };
    } finally {
      syncPromise = null;
    }
  })();
  return syncPromise;
}

export async function saveManualModelPrice(input: {
  modelName: string;
  providerType?: string | null;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m?: number | null;
  cacheWritePer1m?: number | null;
  contextWindow?: number | null;
}): Promise<ModelPriceCatalogEntry> {
  await modelPriceCatalog.disableManualForModel(input.modelName, input.providerType ?? null);
  return modelPriceCatalog.create({
    modelName: input.modelName,
    providerType: input.providerType ?? null,
    inputPer1m: input.inputPer1m,
    outputPer1m: input.outputPer1m,
    cacheReadPer1m: input.cacheReadPer1m ?? null,
    cacheWritePer1m: input.cacheWritePer1m ?? null,
    contextWindow: input.contextWindow ?? null,
    source: "manual",
    sourceUrl: null,
    version: `manual:${new Date().toISOString()}`,
  });
}
