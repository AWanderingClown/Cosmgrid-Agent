// v0.9 阶段7 — 相似度计算 + 语义缓存安全过滤
//
// 纯函数集合，无外部依赖，供 semantic-cache 与 smart-router 使用。
// 决策点③：自用阶段缓存 <1000 条，纯 JS 余弦 <50ms 够用，不引 sqlite-vec。

/** 缓存命中阈值（余弦相似度 ≥ 此值才算命中） */
export const SIMILARITY_THRESHOLD = 0.92;

/**
 * 余弦相似度：只看方向不看模长，范围 [-1, 1]。
 * 任一向量为零向量时返回 0（不除零）。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: 向量长度不一致 (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 时间敏感词：答案随时间变化，缓存会过期给错 → 这类 query 不入缓存
const TIME_SENSITIVE_MARKERS = [
  "今天", "现在", "最新", "实时", "此刻", "目前", "股价", "汇率", "天气", "几点", "当前",
  "today", "now", "latest", "current", "realtime", "real-time", "price", "weather",
];

/** query 是否时间敏感（含上述词即是） */
export function isTimeSensitive(text: string): boolean {
  const lower = text.toLowerCase();
  return TIME_SENSITIVE_MARKERS.some((m) => lower.includes(m));
}

const CODE_FENCE = /```/;
const DIFF_MARKER = /^[+-]\s|\bdiff\b/im;

/** 文本是否含代码（围栏块或 diff 标记） */
export function containsCode(text: string): boolean {
  return CODE_FENCE.test(text) || DIFF_MARKER.test(text);
}

/**
 * 保守接入判定：一对 (query, response) 是否可以写入语义缓存。
 * - 时间敏感 query → 不缓存（答案会过期）
 * - 答案含代码 → 不缓存（上下文略异时复用会给错代码，仅可作"可能相关"提示，不自动复用）
 */
export function isCacheable(query: string, response: string): boolean {
  if (isTimeSensitive(query)) return false;
  if (containsCode(response)) return false;
  return true;
}
