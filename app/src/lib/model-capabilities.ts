// 模型能力知识库（纯静态推断，属于模型目录/配置资产，中立位置——不挂在 lib/llm 下，
// 好让 lib/db 这类 L0 状态层也能直接引用，不用反向依赖 lib/llm）。
//
// 设计原则：
// 1. 纯静态规则，不调 AI、不联网——加模型那一刻就能立即出结果，离线可用、零成本、结果可预测
// 2. 按"模型家族"识别能力档位（旗舰 / 均衡 / 轻量），认不出的给中庸默认分，绝不报错
// 3. 只产出"默认值"，用户在 UI 上永远能覆盖——这是减负，不是夺权

import { WORK_ROLES, type WorkRole } from "@/lib/api";

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
