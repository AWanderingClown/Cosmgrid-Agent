// D4：额度熔断守卫构造 —— 把"模型端点 → 对应套餐额度是否耗尽"算成一个窄接口，
// 交给 streamWithFallback 在入口跳过额度耗尽的模型。本模块不耦合 streamWithFallback
// 主循环，也不直接碰 DB（DB 读取在调用方 stream-runtime 做），保持 CLI / 无 DB 路径安全。

import type { ModelEndpoint } from "./chat-fallback-types";
import {
  computeTokenPlanUsageMap,
  computeTokenPlanUsageMapFromAggregates,
  type TokenPlanUsageSnapshot,
} from "./token-plan-usage";
import type { TokenPlan, UsageAggregateRow, UsageEventRow } from "../db";

export interface QuotaGuard {
  /** 返回当前额度已耗尽的模型 modelId 集合。 */
  getExhaustedModelIds(): Promise<Set<string>> | Set<string>;
}

/**
 * 单个套餐是否额度耗尽。
 * - 没设总额度（totalQuota 为 null/0）→ 不限，不耗尽。
 * - autoTrackable 套餐：用从 usage_events 滚算出的 usedQuota 比对。
 * - 手动记录套餐（非 autoTrackable）：usedQuota 直接取 plan.usedQuota（computeTokenPlanUsage
 *   已把它原样放进 snapshot.usedQuota），同样比对。
 */
export function isPlanExhausted(plan: TokenPlan, usage: TokenPlanUsageSnapshot): boolean {
  if (plan.totalQuota == null || plan.totalQuota <= 0) return false;
  return usage.usedQuota >= plan.totalQuota;
}

/** models × plans → 已耗尽的 modelId 集合，跟 usage 具体怎么算出来的（原始行 reduce 还是
 *  SQL 聚合）无关，两个 buildQuotaGuard* 入口共用这一段判定逻辑。 */
function exhaustedModelIdsFrom(
  models: ModelEndpoint[],
  plans: TokenPlan[],
  usageMap: Map<string, TokenPlanUsageSnapshot>,
): Set<string> {
  const exhausted = new Set<string>();
  for (const m of models) {
    for (const plan of plans) {
      if (plan.providerId !== m.providerId) continue;
      if (plan.linkedApiCredentialId && plan.linkedApiCredentialId !== m.apiCredentialId) continue;
      const usage = usageMap.get(plan.id);
      if (usage && isPlanExhausted(plan, usage)) {
        exhausted.add(m.modelId);
        break;
      }
    }
  }
  return exhausted;
}

/**
 * 根据 models + 套餐列表 + 用量事件，算出额度已耗尽的 modelId 集合。
 * 套餐与端点按 providerId 关联，若套餐绑定了具体 apiCredential 则再按 credentialId 收窄。
 */
export async function buildQuotaGuard(
  models: ModelEndpoint[],
  plans: TokenPlan[],
  usageRows: UsageEventRow[],
): Promise<QuotaGuard> {
  const usageMap = computeTokenPlanUsageMap(plans, usageRows);
  return { getExhaustedModelIds: () => exhaustedModelIdsFrom(models, plans, usageMap) };
}

/**
 * 2026-07-15 review 修复：跟 buildQuotaGuard 判定逻辑完全一致，只是 usage 来源换成 SQL
 * 侧已经按 (provider_id, api_credential_id) 分组聚合好的行（见 usageEvents.
 * aggregateByProviderCredential），不用把 usage_events 全表原始记录拉进 JS——这是
 * stream-runtime.ts 每次发消息都要调的热路径，走聚合版避免历史越多越卡。
 */
export async function buildQuotaGuardFromAggregates(
  models: ModelEndpoint[],
  plans: TokenPlan[],
  aggregates: UsageAggregateRow[],
): Promise<QuotaGuard> {
  const usageMap = computeTokenPlanUsageMapFromAggregates(plans, aggregates);
  return { getExhaustedModelIds: () => exhaustedModelIdsFrom(models, plans, usageMap) };
}
