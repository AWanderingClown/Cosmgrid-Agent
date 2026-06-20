// 痛点 3：按消息难度自动派模型（省钱 + 让每个模型只做它擅长的活）
//
// 病根：用户在主对话里选定一个模型后，问"标点改一下"和"帮我设计架构"都用同一个模型
// 一路聊到底——要么简单问题用贵模型（烧钱），要么难问题用便宜模型（答不好）。
//
// 解法：每条消息发出前，先用纯静态规则判断它的难度（简单 / 标准 / 难），再据此挑一个
// 对应档位、且当前可用的模型。延续 model-capabilities 的哲学：纯规则、不调 AI、零成本、
// 离线可预测。判断不准也不致命——这只是"自动模式"下的默认，用户随时能切回手动选模型。
//
// 注意：这里只决定"这条消息用哪个主模型"。限额自动换备用模型是痛点 1（rankFallbackModels），
// 两者组合：本函数挑主模型 → rankFallbackModels 给它排备用链。

import { detectModelTier, scoreModelForRole, type ModelTier, type ScorableModel } from "./model-capabilities";

/** 消息难度档位 */
export type MessageComplexity = "simple" | "standard" | "hard";

// 难活信号：要深度推理 / 大改动的词（中英）
const HARD_MARKERS = [
  "架构", "设计", "重构", "调试", "排查", "为什么", "方案", "优化", "算法",
  "分析", "审查", "规划", "梳理", "怎么实现", "如何实现", "性能",
  "architecture", "design", "refactor", "debug", "optimize", "algorithm",
  "analyze", "review", "why ", "how should", "trade-off", "tradeoff",
];

// 简单活信号：轻量、确定性高的词 + 寒暄（中英）
const SIMPLE_MARKERS = [
  "翻译", "改名", "重命名", "格式化", "标点", "总结一下", "什么意思", "改个", "润色", "纠错",
  "translate", "rename", "format", "typo", "summarize", "what does", "what is the meaning",
  // 寒暄 / 确认类
  "你好", "您好", "嗨", "谢谢", "多谢", "好的", "在吗", "在不在",
  "hi", "hello", "thanks", "thank you", "ok", "okay",
];

// 极短消息兜底阈值：CJK 里短=信息密度高，编码请求往往也很短（"帮我写个组件"），
// 所以不能"短就当简单"，只对极短（≤4 字）且无代码的兜底成简单，其余短消息默认 standard 更稳。
const SIMPLE_MAX_LEN = 4;
const HARD_MIN_LEN = 800; // 超长消息倾向难
const CODE_FENCE = /```/g;

function countCodeFences(text: string): number {
  const m = text.match(CODE_FENCE);
  return m ? m.length : 0;
}

function includesAny(lower: string, markers: string[]): boolean {
  return markers.some((m) => lower.includes(m));
}

/**
 * 纯静态规则判断一条消息的难度。
 * 优先级：难信号 > 简单信号 > 长度/代码兜底。
 * - 命中难词、或超长、或含多段代码 → hard
 * - 命中简单词、或很短且无代码 → simple
 * - 其余 → standard
 */
export function classifyMessageComplexity(text: string): MessageComplexity {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const fences = countCodeFences(trimmed);

  // 难：关键词 / 超长 / 多段代码（一对 ``` = 2 个 fence，≥2 段代码即 4 个）
  if (includesAny(lower, HARD_MARKERS) || trimmed.length >= HARD_MIN_LEN || fences >= 4) {
    return "hard";
  }

  // 简单：关键词；或很短且不含代码
  if (includesAny(lower, SIMPLE_MARKERS) || (trimmed.length <= SIMPLE_MAX_LEN && fences === 0)) {
    return "simple";
  }

  return "standard";
}

/** 难度 → 目标模型档位 */
export function complexityToTier(c: MessageComplexity): ModelTier {
  if (c === "simple") return "fast";
  if (c === "hard") return "flagship";
  return "balanced";
}

/**
 * 当目标档位没有可用模型时的降级偏好顺序：
 * - 难题：宁可用更强的，也不要用太弱的 → flagship > balanced > fast
 * - 简单题：宁可用更便宜的省钱 → fast > balanced > flagship
 * - 标准题：居中，缺了往强档靠 → balanced > flagship > fast
 */
function tierPreference(tier: ModelTier): ModelTier[] {
  switch (tier) {
    case "flagship":
      return ["flagship", "balanced", "fast", "unknown"];
    case "fast":
      return ["fast", "balanced", "flagship", "unknown"];
    default:
      return ["balanced", "flagship", "fast", "unknown"];
  }
}

/** 选档位用的模型形状：要能拿到名字判档位 + 打分 */
export type RoutableModel = ScorableModel;

function bestByScore<T extends RoutableModel>(models: T[], role: string): T | null {
  if (models.length === 0) return null;
  let best = models[0]!;
  let bestScore = scoreModelForRole(best, role);
  for (const m of models.slice(1)) {
    const s = scoreModelForRole(m, role);
    if (s > bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return best;
}

/**
 * 痛点 3 主入口：给一条消息和当前可用模型，挑出"该用哪个主模型"。
 * 1. 判断消息难度 → 目标档位
 * 2. 按降级偏好顺序找第一个"有可用模型"的档位，档位内取该角色能力分最高的
 * 3. 实在没有（理论上 models 非空时不会）→ null
 *
 * @param role 评分用的角色，默认主对话
 */
export function pickModelForMessage<T extends RoutableModel>(
  text: string,
  models: T[],
  role = "main_chat",
): { model: T; complexity: MessageComplexity } | null {
  if (models.length === 0) return null;
  const complexity = classifyMessageComplexity(text);
  const target = complexityToTier(complexity);

  for (const tier of tierPreference(target)) {
    const inTier = models.filter((m) => detectModelTier(m.name) === tier);
    const best = bestByScore(inTier, role);
    if (best) return { model: best, complexity };
  }

  // 兜底：所有模型都没识别出档位等极端情况 → 拿全局最佳
  const fallback = bestByScore(models, role);
  return fallback ? { model: fallback, complexity } : null;
}
