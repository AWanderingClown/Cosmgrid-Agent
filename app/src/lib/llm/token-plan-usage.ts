import type { TokenPlan, UsageAggregateRow, UsageEventRow } from "../db";

export interface TokenPlanUsageSnapshot {
  planId: string;
  usedQuota: number;
  source: "recorded" | "manual";
  autoTrackable: boolean;
  recordedEvents: number;
  unknownPricingCalls: number;
}

const AUTO_TRACKABLE_UNITS = new Set(["usd", "token", "request", "message"]);

export function computeTokenPlanUsage(
  plan: TokenPlan,
  rows: UsageEventRow[],
): TokenPlanUsageSnapshot {
  const autoTrackable = AUTO_TRACKABLE_UNITS.has(plan.quotaUnit);
  if (!autoTrackable) {
    return {
      planId: plan.id,
      usedQuota: plan.usedQuota,
      source: "manual",
      autoTrackable: false,
      recordedEvents: 0,
      unknownPricingCalls: 0,
    };
  }

  const matchedRows = rows.filter((r) => {
    if (r.providerId !== plan.providerId) return false;
    if (plan.linkedApiCredentialId && r.apiCredentialId !== plan.linkedApiCredentialId) return false;
    return true;
  });

  const usedQuota = matchedRows.reduce((sum, r) => {
    if (plan.quotaUnit === "usd") return sum + r.cost;
    if (plan.quotaUnit === "token") {
      return sum + r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheHitTokens;
    }
    return sum + 1;
  }, 0);

  return {
    planId: plan.id,
    usedQuota,
    source: "recorded",
    autoTrackable: true,
    recordedEvents: matchedRows.length,
    unknownPricingCalls: plan.quotaUnit === "usd"
      ? matchedRows.filter((r) => r.pricingKnown === false).length
      : 0,
  };
}

export function computeTokenPlanUsageMap(
  plans: TokenPlan[],
  rows: UsageEventRow[],
): Map<string, TokenPlanUsageSnapshot> {
  return new Map(plans.map((plan) => [plan.id, computeTokenPlanUsage(plan, rows)]));
}

/**
 * 2026-07-15 review 修复：跟 computeTokenPlanUsage 算的是同一件事（套餐是否耗尽只需要
 * cost/tokens 总和 + 记录数，不需要每条原始记录），但输入换成 SQL 侧已经按
 * (provider_id, api_credential_id) 分组聚合好的行（见 usage-events.ts 的
 * aggregateByProviderCredential）。quota guard 每次发消息都要跑一次这个判定，走聚合版
 * 能避免把全表原始记录拉进 JS 再 reduce——聚合行数只跟"用过几种 provider+credential
 * 组合"成正比，跟 usage_events 总行数无关。
 */
export function computeTokenPlanUsageFromAggregates(
  plan: TokenPlan,
  aggregates: UsageAggregateRow[],
): TokenPlanUsageSnapshot {
  const autoTrackable = AUTO_TRACKABLE_UNITS.has(plan.quotaUnit);
  if (!autoTrackable) {
    return {
      planId: plan.id,
      usedQuota: plan.usedQuota,
      source: "manual",
      autoTrackable: false,
      recordedEvents: 0,
      unknownPricingCalls: 0,
    };
  }

  const matched = aggregates.filter((a) => {
    if (a.providerId !== plan.providerId) return false;
    if (plan.linkedApiCredentialId && a.apiCredentialId !== plan.linkedApiCredentialId) return false;
    return true;
  });

  const usedQuota = matched.reduce((sum, a) => {
    if (plan.quotaUnit === "usd") return sum + a.totalCost;
    if (plan.quotaUnit === "token") return sum + a.totalTokens;
    return sum + a.recordedEvents;
  }, 0);

  return {
    planId: plan.id,
    usedQuota,
    source: "recorded",
    autoTrackable: true,
    recordedEvents: matched.reduce((sum, a) => sum + a.recordedEvents, 0),
    unknownPricingCalls: plan.quotaUnit === "usd"
      ? matched.reduce((sum, a) => sum + a.unknownPricingCalls, 0)
      : 0,
  };
}

export function computeTokenPlanUsageMapFromAggregates(
  plans: TokenPlan[],
  aggregates: UsageAggregateRow[],
): Map<string, TokenPlanUsageSnapshot> {
  return new Map(plans.map((plan) => [plan.id, computeTokenPlanUsageFromAggregates(plan, aggregates)]));
}
