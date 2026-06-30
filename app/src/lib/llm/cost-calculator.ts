// 成本计算器（纯函数）
// 根据 Vercel AI SDK 的 usage 字段计算 USD 成本
//
// 关键设计：
// 1. 纯函数，无副作用（便于测试 + 缓存 + 并发）
// 2. cache token 必须从 input 里扣掉（避免重复计算）
// 3. 未知模型返回 cost=0 + pricingKnown=false（不抛错，对话不被阻塞）
// 4. 4 位小数精度（USD 微支付场景需要）
//
// token 关系（来自 Anthropic 计费规则）：
//   - input tokens 包含 cache_read + cache_write + 真正新增的 input
//   - cache_read 通常是 input 价格的 10%
//   - cache_write 通常是 input 价格的 125%（25% 写入费）
//   - output tokens 单独计费
import { lookupPrice } from "./model-prices.js";
import { lookupPriceFromCatalog, type ResolvedModelPrice } from "./price-catalog.js";

/** Vercel AI SDK 6 的 Usage 字段（覆盖 Anthropic / OpenAI / Google） */
export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Anthropic prompt cache 命中 */
  cacheReadInputTokens?: number;
  /** Anthropic prompt cache 写入 */
  cacheWriteInputTokens?: number;
  /** OpenAI o1/o3 reasoning tokens（已包含在 outputTokens 里） */
  reasoningTokens?: number;
}

export interface CostEstimate {
  /** USD 成本（4 位小数）；未知价格时为 0，只代表无法估算，不代表免费 */
  cost: number;
  /** true = 找到了价格表；false = 需要用户补价格或等待价格源同步 */
  pricingKnown: boolean;
}

export interface CatalogCostEstimate extends CostEstimate {
  priceCatalogId: string | null;
  priceVersion: string | null;
  priceSource: "builtin" | "remote" | "manual" | null;
  priceSourceUrl: string | null;
  resolvedPrice: ResolvedModelPrice | null;
}

/**
 * 估算单次对话的成本（USD）并返回价格可信状态。
 * @param modelName - DB Model.name
 * @param usage - Vercel AI SDK 返回的 usage 字段
 * @returns 成本估算 + 是否命中价格表
 */
export function estimateCost(modelName: string, usage: ChatUsage): CostEstimate {
  const price = lookupPrice(modelName);
  if (!price) {
    console.warn(`[cost-calculator] 未知模型 ${modelName}，无法计算成本`);
    return { cost: 0, pricingKnown: false };
  }

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;

  // 真正"新增"的 input token（不算 cache 部分）
  const nonCacheInput = Math.max(0, input - cacheRead - cacheWrite);

  // cache 部分单独计费（provider 不支持 cache 时 fallback 到 input 价格）
  const cacheReadRate = price.cacheRead ?? price.input;
  const cacheWriteRate = price.cacheWrite ?? price.input * 1.25;

  const cost =
    (nonCacheInput / 1_000_000) * price.input +
    (output / 1_000_000) * price.output +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheWrite / 1_000_000) * cacheWriteRate;

  // 4 位小数精度（处理浮点误差）
  return { cost: Math.round(cost * 10_000) / 10_000, pricingKnown: true };
}

function estimateCostFromResolvedPrice(
  resolvedPrice: ResolvedModelPrice | null,
  usage: ChatUsage,
): CatalogCostEstimate {
  if (!resolvedPrice) {
    return {
      cost: 0,
      pricingKnown: false,
      priceCatalogId: null,
      priceVersion: null,
      priceSource: null,
      priceSourceUrl: null,
      resolvedPrice: null,
    };
  }

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const nonCacheInput = Math.max(0, input - cacheRead - cacheWrite);
  const cacheReadRate = resolvedPrice.cacheRead ?? resolvedPrice.input;
  const cacheWriteRate = resolvedPrice.cacheWrite ?? resolvedPrice.input * 1.25;

  const cost =
    (nonCacheInput / 1_000_000) * resolvedPrice.input +
    (output / 1_000_000) * resolvedPrice.output +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheWrite / 1_000_000) * cacheWriteRate;

  return {
    cost: Math.round(cost * 10_000) / 10_000,
    pricingKnown: true,
    priceCatalogId: resolvedPrice.catalogId,
    priceVersion: resolvedPrice.version,
    priceSource: resolvedPrice.source,
    priceSourceUrl: resolvedPrice.sourceUrl,
    resolvedPrice,
  };
}

export async function estimateCostWithCatalog(
  modelName: string,
  usage: ChatUsage,
  providerType?: string | null,
): Promise<CatalogCostEstimate> {
  const resolvedPrice = await lookupPriceFromCatalog(modelName, providerType);
  if (!resolvedPrice) {
    console.warn(`[cost-calculator] 未知模型 ${modelName}，无法计算成本`);
  }
  return estimateCostFromResolvedPrice(resolvedPrice, usage);
}

/**
 * 兼容旧调用方：只要数字成本。
 * 新写入用量事件时请优先用 estimateCost，把未知价格显式落库。
 */
export function calculateCost(modelName: string, usage: ChatUsage): number {
  return estimateCost(modelName, usage).cost;
}
