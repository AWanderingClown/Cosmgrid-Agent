// 模型能力知识库 + 自动分配
// 解决的核心痛点：用户接入多个模型后，不该让他一个一个手动勾"这个模型适合哪些角色"、
// 再到模板里一个一个角色去选模型。系统应该"自己知道"哪个模型擅长什么，自动配好默认，
// 用户只在想调整时改。
//
// 设计原则：
// 1. 纯静态规则，不调 AI、不联网——加模型那一刻就能立即出结果，离线可用、零成本、结果可预测
// 2. 按"模型家族"识别能力档位（旗舰 / 均衡 / 轻量），认不出的给中庸默认分，绝不报错
// 3. 只产出"默认值"，用户在 UI 上永远能覆盖——这是减负，不是夺权

import { WORK_ROLES, type WorkRole, parseWorkRoles } from "@/lib/api";

/** 模型能力档位 */
export type ModelTier = "flagship" | "balanced" | "fast" | "unknown";

/** 角色分三类，不同档位的模型在不同类别上得分不同 */
// 重推理：要深度思考的活（规划、审查、建模、数据探索、最终复核）
const REASONING_ROLES: WorkRole[] = [
  "planning",
  "review",
  "final_review",
  "data_exploration",
  "modeling",
];
// 轻量：相对简单、量大的活（测试）
const LIGHT_ROLES: WorkRole[] = ["testing"];
// 其余角色（main_chat / frontend / backend / ios / android / direct_generation / general）
// 归为"重执行"类：写代码、直接产出。见 roleCategory 的兜底分支。

/** 每个档位在 [重推理, 重执行, 轻量] 三类上的得分（0-100） */
const TIER_SCORES: Record<ModelTier, { reasoning: number; coding: number; light: number }> = {
  flagship: { reasoning: 95, coding: 88, light: 82 },
  balanced: { reasoning: 82, coding: 90, light: 85 },
  fast: { reasoning: 68, coding: 76, light: 92 },
  unknown: { reasoning: 70, coding: 72, light: 72 },
};

// 高于这个分，才算"这个模型适合这个角色"（写进 workRoles）
const WORK_ROLE_THRESHOLD = 75;

/**
 * 标记匹配：短标记（<5 字符，如 mini/pro/o1）按"词"匹配，避免 "mini" 命中 "geMINI"、
 * "pro" 命中 "proxy"；长标记（≥5 字符，如 opus/sonnet/gemini）用子串即可，不会误伤。
 */
function matchesAny(modelName: string, markers: string[]): boolean {
  const lower = modelName.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return markers.some((m) => (m.length >= 5 ? lower.includes(m) : tokens.includes(m)));
}

/**
 * 按模型名识别能力档位。匹配顺序很重要：
 * 先识别"轻量变体"（mini/haiku/flash-lite…），再识别"旗舰"（opus/pro/o1…），否则按"均衡"，都不沾就 unknown。
 * 这样 "gpt-4o-mini" 会被判成 fast 而不是 balanced，"gemini-2.5-pro" 会被判成 flagship。
 */
export function detectModelTier(modelName: string): ModelTier {
  const fastMarkers = ["haiku", "mini", "flash-lite", "8b", "lite", "nano", "small"];
  if (matchesAny(modelName, fastMarkers)) return "fast";

  const flagshipMarkers = [
    "opus",
    "gpt-5",
    "o1",
    "o3",
    "o4",
    "pro",
    "deepseek-r",
    "reasoner",
    "grok-4",
    "qwen-max",
    "qwq",
  ];
  if (matchesAny(modelName, flagshipMarkers)) return "flagship";

  const balancedMarkers = [
    "sonnet",
    "gpt-4",
    "4o",
    "gemini",
    "flash",
    "deepseek-v",
    "deepseek-chat",
    "qwen",
    "grok",
    "llama",
    "mistral",
    "glm",
    "kimi",
    "moonshot",
  ];
  if (matchesAny(modelName, balancedMarkers)) return "balanced";

  return "unknown";
}

function roleCategory(role: string): "reasoning" | "coding" | "light" {
  if (REASONING_ROLES.includes(role as WorkRole)) return "reasoning";
  if (LIGHT_ROLES.includes(role as WorkRole)) return "light";
  return "coding";
}

export interface InferredCapabilities {
  tier: ModelTier;
  /** 每个角色的能力分（0-100），覆盖 WORK_ROLES 全集 */
  capabilityScore: Record<string, number>;
  /** 推荐承担的角色（分数 ≥ 阈值的）；认不出的模型至少给主对话 + 通用兜底 */
  workRoles: WorkRole[];
}

/** 根据模型名，推断它的角色能力分 + 推荐角色 */
export function inferModelCapabilities(modelName: string): InferredCapabilities {
  const tier = detectModelTier(modelName);
  const tierScore = TIER_SCORES[tier];

  const capabilityScore: Record<string, number> = {};
  for (const role of WORK_ROLES) {
    capabilityScore[role] = tierScore[roleCategory(role)];
  }

  let workRoles = WORK_ROLES.filter((r) => capabilityScore[r]! >= WORK_ROLE_THRESHOLD);
  // 认不出的模型整体没到阈值——至少让它能做主对话和兜底，不然它在模板里永远被忽略
  if (workRoles.length === 0) {
    workRoles = ["main_chat", "general"];
  }

  return { tier, capabilityScore, workRoles };
}

/** 解析模型已存的 capabilityScore JSON（坏数据返回空对象，绝不抛错） */
function parseScoreMap(json: string | null): Record<string, number> {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, number>;
    }
    return {};
  } catch {
    return {};
  }
}

/** 自动分配用的最小模型形状（兼容 db.Model / ModelListItem） */
export interface ScorableModel {
  id: string;
  name: string;
  capabilityScore: string | null;
  workRoles: string;
}

/**
 * 给定角色，给一个模型打分：
 * 1. 优先用模型已存的 capabilityScore（用户/系统写过的）
 * 2. 没存就用模型名实时推断
 * 3. 再看 workRoles 是否包含该角色做微调，让"用户明确勾过这个角色"的模型更靠前
 */
export function scoreModelForRole(model: ScorableModel, role: string): number {
  const stored = parseScoreMap(model.capabilityScore);
  const base =
    stored[role] !== undefined
      ? stored[role]!
      : inferModelCapabilities(model.name).capabilityScore[role] ?? 0;

  const roles = parseWorkRoles(model.workRoles);
  // 用户明确把这个角色勾给了它 → 小幅加权（让人工意图压过纯名字推断）
  if (roles.includes(role)) return base + 5;
  return base;
}

/** 从候选模型里，为某个角色挑最合适的一个（并列取第一个）。没有候选返回 null */
export function pickBestModelForRole<T extends ScorableModel>(role: string, models: T[]): T | null {
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

/** 回退链排序用的模型形状：在 ScorableModel 基础上要知道它属于哪个供应商 */
export interface RankableModel extends ScorableModel {
  providerId: string;
}

/**
 * 痛点 1：主模型限额/失败时，排出"接下来按什么顺序尝试别的模型"的候选链。
 *
 * 规则：
 * 1. 排除主模型自己（按 id）
 * 2. 优先不同供应商——限额/429 通常是某家 key 或套餐的额度，切同厂兄弟模型救不了
 * 3. 同一"是否换厂"档内，再按该角色能力分高的排前面
 * 4. 截断到 limit（默认 3）：够用，且调用方不必为一大堆模型都去解密 API Key
 *
 * 纯函数，无副作用——把排序逻辑从 ChatPage 抽出来单独可测。
 * 调用方拿到顺序后再逐个解析凭证 / apiKey、构造 ModelEndpoint。
 */
export function rankFallbackModels<T extends RankableModel>(
  primary: { id: string; providerId: string },
  candidates: T[],
  role: string,
  limit = 3,
): T[] {
  return candidates
    .filter((m) => m.id !== primary.id)
    .map((m) => ({
      m,
      score: scoreModelForRole(m, role),
      differentProvider: m.providerId !== primary.providerId,
    }))
    .sort((a, b) => {
      if (a.differentProvider !== b.differentProvider) return a.differentProvider ? -1 : 1;
      return b.score - a.score;
    })
    .slice(0, Math.max(0, limit))
    .map((x) => x.m);
}

/** 给一组角色批量自动分配模型，返回 role → modelId 的映射（无候选模型时跳过该角色） */
export function autoAssignModels<T extends ScorableModel>(
  roles: string[],
  models: T[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const role of roles) {
    const best = pickBestModelForRole(role, models);
    if (best) result.set(role, best.id);
  }
  return result;
}
