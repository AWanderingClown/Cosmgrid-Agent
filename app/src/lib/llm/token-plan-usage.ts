import type { TokenPlan, UsageEventRow } from "../db";

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
