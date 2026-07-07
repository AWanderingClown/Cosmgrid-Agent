// 模型自动分配 / 回退排序（L2 调度层）。
// 纯"模型名 → 能力档位"的推断逻辑属于中立的模型目录配置，已挪到 @/lib/model-capabilities
// （好让 lib/db 这类 L0 状态层也能直接引用，不必反向依赖 lib/llm）；这里只保留会用到
// 该推断结果的调度/排序逻辑。

import { parseWorkRoles } from "@/lib/api";
import { inferModelCapabilities } from "@/lib/model-capabilities";

export { detectModelTier, inferModelCapabilities, type ModelTier, type InferredCapabilities } from "@/lib/model-capabilities";

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
