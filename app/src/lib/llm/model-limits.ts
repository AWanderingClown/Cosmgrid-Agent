// 每个模型的真实「输出 token 上限」表，按它把 maxOutputTokens clamp 到模型能力之内。
//
// 数据源 = models.dev（https://models.dev/api.json）——opencode / 多家 AI 工具共用的公共
// 模型注册表，只读 GET、permissive CORS。里面每个模型都带 limit.context（输入上下文，现在
// 主流普遍 100k~1M）和 limit.output（单次回答最多吐多少 token）。
//
// 为什么要这张表（对齐 opencode 的做法）：
//  - 不传 max_tokens → 供应商用各自的小默认值，推理型模型（MiniMax-M3 等）正文会被截断；
//  - 传死的大值（如 32000）→ 输出上限本来就小的模型（个别老模型）会被供应商 400 拒。
//  正解：maxOutputTokens = min(模型真实输出上限, CEILING) || CEILING（查不到就用 CEILING 兜底）。

/** 输出预算封顶值。取 Claude Code 二进制里见到的最高档 64000——让 claude-opus(64000)、
 *  gemini-2.5-pro(65536) 这类高上限模型也能用满，不被人为压低。max_tokens 是「上限」不是
 *  「预扣」（按实际产出计费），抬高它几乎零成本、只防截断。封顶仍保留：挡住 models.dev 偶发
 *  把「输出上限」错标成「上下文长度」的离谱值（如某些源把 MiniMax-M3 标成 1,000,000 输出）。 */
export const MAX_OUTPUT_TOKENS_CEILING = 64_000;

/** 压缩历史查不到模型真实上下文窗口时的兜底预算——跟 context-compressor.ts 自己的默认值保持一致。 */
export const DEFAULT_COMPRESSION_BUDGET = 12_000;

/** 给「模型这次回答」预留的缓冲上限——对齐 opencode 的 COMPACTION_BUFFER。
 *  不是把模型的完整输出上限都扣掉（那样上下文窗口大部分模型都够用不着这么保守），
 *  只留一个够用的缓冲，其余全部拿来装历史消息。 */
export const COMPACTION_RESERVE_CEILING = 20_000;

const MODELS_DEV_URL = "https://models.dev/api.json";
const STORAGE_KEY = "cosmgrid:model-output-limits:v1";
const CONTEXT_STORAGE_KEY = "cosmgrid:model-context-limits:v1";

/** 归一化模型名：小写 + 去首尾空白，做宽松匹配（用户填的名字大小写不一） */
function normalize(id: string): string {
  return id.toLowerCase().trim();
}

// 模块级缓存：normalize(modelId) → 输出上限 / 上下文窗口。null 表示还没加载过。
let limitMap: Map<string, number> | null = null;
let contextLimitMap: Map<string, number> | null = null;
let loadPromise: Promise<void> | null = null;

function loadFromStorage(key: string): Map<string, number> | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(obj));
  } catch {
    return null;
  }
}

function saveToStorage(key: string, map: Map<string, number>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // localStorage 不可用 / 配额满：忽略，下次启动重新拉
  }
}

/** 从 models.dev 的 api.json 结构里按 `field`（"output" 或 "context"）抽取 modelId → 数值表。
 *  两张表（输出上限 / 上下文窗口）共用同一套 key 归一化逻辑，只是取的字段不同。 */
function extractLimitField(json: unknown, field: "output" | "context"): Map<string, number> {
  const map = new Map<string, number>();
  if (!json || typeof json !== "object") return map;
  for (const provider of Object.values(json as Record<string, unknown>)) {
    const models = (provider as { models?: unknown })?.models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, meta] of Object.entries(models as Record<string, unknown>)) {
      const value = (meta as { limit?: Record<string, unknown> })?.limit?.[field];
      if (typeof value !== "number" || value <= 0) continue;
      // 同时按完整 id 和「去掉 provider/ 前缀的基名」建索引：
      // models.dev 的 key 常带前缀（如 "minimax/minimax-m3"），而用户填的多是裸名（"MiniMax-M3"）。
      // 已存在的基名不覆盖（避免同名跨厂商相互踩，先到为准）。
      const keys = new Set<string>([modelId]);
      const altId = (meta as { id?: unknown })?.id;
      if (typeof altId === "string") keys.add(altId);
      for (const k of [...keys]) {
        const slash = k.lastIndexOf("/");
        if (slash >= 0) keys.add(k.slice(slash + 1));
      }
      for (const k of keys) {
        const nk = normalize(k);
        if (!map.has(nk)) map.set(nk, value);
      }
    }
  }
  return map;
}

/** 解析 models.dev 的 api.json 结构：{ [providerId]: { models: { [modelId]: { limit: { output } } } } } */
export function parseModelsDev(json: unknown): Map<string, number> {
  return extractLimitField(json, "output");
}

/** 同上，但抽的是 limit.context（模型真实上下文窗口，给「历史压缩预算」用）。 */
export function parseModelsDevContext(json: unknown): Map<string, number> {
  return extractLimitField(json, "context");
}

/** 拉取并缓存 models.dev 限制表。幂等：并发只发一次；离线时退回本地缓存。
 *  app 启动时 fire-and-forget 调一次即可，后续 resolve 同步读缓存。 */
export async function ensureModelLimitsLoaded(): Promise<void> {
  if (limitMap) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    // 先用上次持久化的缓存兜底，离线也能 clamp
    const cached = loadFromStorage(STORAGE_KEY);
    if (cached && cached.size > 0) limitMap = cached;
    const cachedContext = loadFromStorage(CONTEXT_STORAGE_KEY);
    if (cachedContext && cachedContext.size > 0) contextLimitMap = cachedContext;
    try {
      const res = await fetch(MODELS_DEV_URL, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json = await res.json();
        const parsed = parseModelsDev(json);
        if (parsed.size > 0) {
          limitMap = parsed;
          saveToStorage(STORAGE_KEY, parsed);
        }
        const parsedContext = parseModelsDevContext(json);
        if (parsedContext.size > 0) {
          contextLimitMap = parsedContext;
          saveToStorage(CONTEXT_STORAGE_KEY, parsedContext);
        }
      }
    } catch {
      // 网络失败：保留 cached（或留空，由 resolve 用 CEILING/DEFAULT 兜底）
    } finally {
      if (!limitMap) limitMap = new Map();
      if (!contextLimitMap) contextLimitMap = new Map();
    }
  })();
  return loadPromise;
}

/** 查模型真实输出上限（models.dev）。未加载或查不到 → undefined。 */
export function getModelOutputLimit(modelName: string): number | undefined {
  if (!limitMap) return undefined;
  return limitMap.get(normalize(modelName));
}

/** 查模型真实上下文窗口（models.dev）。未加载或查不到 → undefined。 */
export function getModelContextWindow(modelName: string): number | undefined {
  if (!contextLimitMap) return undefined;
  return contextLimitMap.get(normalize(modelName));
}

/** 本次调用该传的 maxOutputTokens：clamp 到模型真实上限、封顶 CEILING、查不到用 CEILING。
 *  对齐 opencode：min(limit, CEILING) || CEILING。 */
export function resolveMaxOutputTokens(modelName: string): number {
  const limit = getModelOutputLimit(modelName);
  return Math.min(limit ?? MAX_OUTPUT_TOKENS_CEILING, MAX_OUTPUT_TOKENS_CEILING) || MAX_OUTPUT_TOKENS_CEILING;
}

/** 历史压缩该用的 token 预算：按模型真实上下文窗口算，不再用写死的数字。
 *  对齐 opencode 的 usable()：预留一小段给这次回答（最多 COMPACTION_RESERVE_CEILING，
 *  模型真实输出上限比这个还小就按真实上限来），剩下全部拿来装历史消息。
 *
 * @param knownContextWindow 调用方如果已经有更权威的数据源（如 DB 里 models 表自己的
 *   context_window 字段，来自 price-catalog 同步），优先用它；没有才退回 models.dev 直接查。
 *   两边都查不到 → 退回 DEFAULT_COMPRESSION_BUDGET（沿用改造前的固定预算）。
 */
export function resolveContextBudget(modelName: string, knownContextWindow?: number | null): number {
  const context = knownContextWindow && knownContextWindow > 0 ? knownContextWindow : getModelContextWindow(modelName);
  if (!context || context <= 0) return DEFAULT_COMPRESSION_BUDGET;
  const reserve = Math.min(COMPACTION_RESERVE_CEILING, resolveMaxOutputTokens(modelName));
  const budget = context - reserve;
  return budget > 0 ? budget : DEFAULT_COMPRESSION_BUDGET;
}

/** 仅供测试：直接注入输出上限表（+ 可选上下文窗口表），绕过网络。 */
export function __setLimitMapForTest(
  map: Map<string, number> | null,
  contextMap?: Map<string, number> | null,
): void {
  limitMap = map;
  if (contextMap !== undefined) contextLimitMap = contextMap;
  loadPromise = null;
}
