// 模型定价集中表（参考 LiteLLM model_prices_and_context_window.json）
// 所有价格单位：USD / 1M tokens（行业标准）
// 数据来源：各厂商 2026-06 公开定价
//
// 设计原则：
// 1. 单一数据源 —— 所有成本计算都查这里
// 2. 未知模型返回 null（不抛错，让上层 fallback 到 cost=0）
// 3. cacheRead/cacheWrite 可选（只有 Anthropic 支持 prompt caching）

export interface ModelPrice {
  /** 输入 token 单价（USD / 1M tokens） */
  input: number;
  /** 输出 token 单价 */
  output: number;
  /** 上下文窗口大小 */
  contextWindow: number;
  /** Anthropic prompt cache 读取价（可选） */
  cacheRead?: number;
  /** Anthropic prompt cache 写入价（可选） */
  cacheWrite?: number;
}

/**
 * 集中定价数据
 * key: 模型名（与 DB Model.name 完全一致）
 * value: 价格配置
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // ============ Anthropic ============
  "claude-opus-4-8": {
    input: 15,
    output: 75,
    cacheRead: 1.5, // input 的 10%
    cacheWrite: 18.75, // input 的 125%
    contextWindow: 1_000_000,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    contextWindow: 1_000_000,
  },
  "claude-haiku-4-5": {
    input: 0.8,
    output: 4,
    cacheRead: 0.08,
    cacheWrite: 1,
    contextWindow: 200_000,
  },

  // ============ OpenAI ============
  "gpt-5": {
    input: 5,
    output: 20,
    contextWindow: 256_000,
  },
  "gpt-5-mini": {
    input: 0.5,
    output: 2,
    contextWindow: 256_000,
  },
  "gpt-5-nano": {
    input: 0.1,
    output: 0.4,
    contextWindow: 256_000,
  },

  // ============ Google ============
  "gemini-2.5-pro": {
    input: 1.25,
    output: 5,
    contextWindow: 1_000_000,
  },
  "gemini-2.5-flash": {
    input: 0.075,
    output: 0.3,
    contextWindow: 1_000_000,
  },
};

/**
 * 按模型名查价格（纯函数）
 * @param modelName - DB Model.name（如 "claude-sonnet-4-6"）
 * @returns 价格配置，未知模型返回 null（让调用方决定怎么处理）
 */
export function lookupPrice(modelName: string): ModelPrice | null {
  // 精确匹配优先
  if (modelName in MODEL_PRICES) {
    return MODEL_PRICES[modelName];
  }
  // 大小写不敏感 fallback（避免 "Claude-Sonnet-4-6" 找不到）
  const lower = modelName.toLowerCase();
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (key.toLowerCase() === lower) {
      return price;
    }
  }
  return null;
}