// 用户主观模型分级基线（2026-06-25 用户提供，拍脑袋但实际用过，比名字查表准）。
//
// 用途：真表现数据（model_performance_stats）没积累时作冷启动兜底——
// 替掉 detectModelTier 的纯名字查表（那个把 MiniMax-M3 判 unknown 给 72，不准）。
// 真表现数据跑多了自动覆盖这个（见 pickBestModelWithPerformance 三层优先级）。
//
// 注意：模型名用 aliases 模糊匹配（小写包含），因为用户写法（Opus4.8）和 API 实际模型名
// （claude-opus-4-8 / MiniMax-M3）不一致。匹配不上 fallback 到 detectModelTier。
// 用户用什么 API 不限定——这表只是冷启动兜底，不是硬编码模型清单。

export interface UserTierEntry {
  /** 模型名匹配词（小写，modelName 包含即命中） */
  aliases: string[];
  /** 总分 0-100 */
  score: number;
  /** 擅长的角色（WorkRole）；空数组表示没用过/不确定 */
  strongRoles: string[];
}

export const USER_TIER_BASELINE: readonly UserTierEntry[] = [
  {
    aliases: ["opus-4-8", "opus4.8", "opus 4.8", "opus-4.8", "claude-opus-4-8"],
    score: 95,
    strongRoles: ["planning", "main_chat", "review", "final_review", "backend", "frontend", "testing", "ios", "android", "direct_generation", "general"],
  },
  {
    aliases: ["gpt5.5", "gpt-5.5", "gpt 5.5", "gpt-5"],
    score: 92,
    strongRoles: ["planning", "main_chat", "review", "final_review", "backend", "frontend", "testing", "ios", "android", "direct_generation", "general"],
  },
  {
    aliases: ["gemini3.1", "gemini-3.1", "gemini 3.1", "gemini-3"],
    score: 86,
    strongRoles: ["planning", "main_chat", "frontend"],
  },
  {
    aliases: ["glm5.2", "gml5.2", "glm-5.2", "glm 5.2", "glm5.2"],
    score: 85,
    strongRoles: ["backend", "testing", "review", "final_review"],
  },
  {
    aliases: ["deepseek-v4", "deepseek v4", "deepseekv4", "deepseek"],
    score: 80,
    strongRoles: ["backend", "testing"],
  },
  {
    aliases: ["kimi-2.7", "kimi2.7", "kimi 2.7", "kimi"],
    score: 76,
    strongRoles: ["planning", "main_chat", "backend", "review"],
  },
  {
    aliases: ["minimax-m3", "minimax m3", "minimaxm3", "m3"],
    score: 70,
    strongRoles: ["backend", "review"],
  },
  {
    aliases: ["qwen3.7", "qwen 3.7", "qwen-3.7", "qwen3"],
    score: 70,
    strongRoles: [], // 用户没用过，不知道
  },
  {
    aliases: ["minimax-m2.5", "minimax m2.5", "m2.5"],
    score: 55,
    strongRoles: ["backend"],
  },
  {
    aliases: ["glm-5", "glm5", "glm 5"],
    score: 61,
    strongRoles: ["backend"],
  },
  {
    aliases: ["agnes", "agnes-ai", "agnes ai"],
    score: 60,
    strongRoles: [], // 执行都不确定行不行
  },
];

/**
 * 按用户主观基线给模型在某角色的分。
 * @returns 分数（0-100），或 null（模型不在基线表，调用方 fallback 名字查表）
 *
 * 评分规则：
 * - 擅长该角色 → 满分
 * - 不擅长（但表里有）→ 满分 * 0.6（打折，不推荐但能凑合）
 * - 没用过/不确定（strongRoles 空）→ 满分 * 0.6（跟不擅长一样，没用过不该更高）
 */
export function scoreByUserBaseline(modelName: string, role: string): number | null {
  const lower = modelName.toLowerCase();
  const entry = USER_TIER_BASELINE.find((e) => e.aliases.some((a) => lower.includes(a)));
  if (!entry) return null;
  if (entry.strongRoles.length === 0) return Math.round(entry.score * 0.6);
  if (entry.strongRoles.includes(role)) return entry.score;
  return Math.round(entry.score * 0.6);
}
