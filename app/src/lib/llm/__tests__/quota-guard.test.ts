// D4 额度熔断守卫单测
import { describe, it, expect } from "vitest";
import { isPlanExhausted, buildQuotaGuard, buildQuotaGuardFromAggregates } from "../quota-guard";
import type { TokenPlan, UsageAggregateRow, UsageEventRow } from "../../db";
import type { ModelEndpoint } from "../chat-fallback-types";

function plan(p: Partial<TokenPlan>): TokenPlan {
  return {
    id: "plan-1",
    providerId: "prov-a",
    linkedApiCredentialId: null,
    name: "Plan",
    planType: "monthly",
    quotaUnit: "usd",
    totalQuota: 100,
    usedQuota: 0,
    resetRule: null,
    nextResetAt: null,
    warningThresholds: null,
    status: "active",
    autoTrackEnabled: true,
    manualUpdateRequired: false,
    fallbackModelId: null,
    createdAt: "",
    updatedAt: "",
    ...p,
  };
}

function row(r: Partial<UsageEventRow>): UsageEventRow {
  return {
    id: "u-1",
    projectId: null,
    conversationId: null,
    modelId: "m-1",
    providerId: "prov-a",
    apiCredentialId: "cred-a",
    role: null,
    roleKind: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheHitTokens: 0,
    cost: 0,
    pricingKnown: true,
    priceVersion: null,
    priceSource: null,
    priceCatalogId: null,
    success: true,
    createdAt: "",
    ...r,
  };
}

describe("isPlanExhausted", () => {
  it("没设总额度（null/0）视为不限，不耗尽", () => {
    expect(isPlanExhausted(plan({ totalQuota: null }), { planId: "plan-1", usedQuota: 999, source: "manual", autoTrackable: false, recordedEvents: 0, unknownPricingCalls: 0 })).toBe(false);
    expect(isPlanExhausted(plan({ totalQuota: 0 }), { planId: "plan-1", usedQuota: 999, source: "manual", autoTrackable: false, recordedEvents: 0, unknownPricingCalls: 0 })).toBe(false);
  });

  it("autoTrackable（usd）按记录用量判定：used >= total 才耗尽", () => {
    expect(isPlanExhausted(plan({ totalQuota: 100 }), { planId: "plan-1", usedQuota: 120, source: "recorded", autoTrackable: true, recordedEvents: 1, unknownPricingCalls: 0 })).toBe(true);
    expect(isPlanExhausted(plan({ totalQuota: 100 }), { planId: "plan-1", usedQuota: 99, source: "recorded", autoTrackable: true, recordedEvents: 1, unknownPricingCalls: 0 })).toBe(false);
  });

  it("手动记录套餐（非 autoTrackable）按 plan.usedQuota 判定：>= total 才耗尽", () => {
    expect(isPlanExhausted(plan({ quotaUnit: "custom", totalQuota: 100, usedQuota: 100 }), { planId: "plan-1", usedQuota: 100, source: "manual", autoTrackable: false, recordedEvents: 0, unknownPricingCalls: 0 })).toBe(true);
    expect(isPlanExhausted(plan({ quotaUnit: "custom", totalQuota: 100, usedQuota: 50 }), { planId: "plan-1", usedQuota: 50, source: "manual", autoTrackable: false, recordedEvents: 0, unknownPricingCalls: 0 })).toBe(false);
  });
});

describe("buildQuotaGuard", () => {
  const mPrimary: ModelEndpoint = {
    modelId: "m-primary",
    modelName: "primary",
    providerType: "anthropic",
    providerId: "prov-a",
    apiCredentialId: "cred-a",
    apiKey: "k",
    baseUrl: "https://x",
    displayLabel: "Primary",
  };
  const mFallback: ModelEndpoint = {
    modelId: "m-fallback",
    modelName: "fallback",
    providerType: "openai",
    providerId: "prov-b",
    apiCredentialId: "cred-b",
    apiKey: "k",
    baseUrl: "https://y",
    displayLabel: "Fallback",
  };

  it("套餐额度耗尽 → 对应模型进入 exhausted 集合", async () => {
    const plans = [
      plan({ id: "plan-a", providerId: "prov-a", quotaUnit: "usd", totalQuota: 100 }),
    ];
    const rows = [row({ providerId: "prov-a", apiCredentialId: "cred-a", cost: 120 })];
    const guard = await buildQuotaGuard([mPrimary, mFallback], plans, rows);
    const exhausted = await guard.getExhaustedModelIds();
    expect(exhausted.has("m-primary")).toBe(true);
    expect(exhausted.has("m-fallback")).toBe(false);
  });

  it("套餐额度未耗尽 → 不进入 exhausted 集合", async () => {
    const plans = [plan({ id: "plan-a", providerId: "prov-a", quotaUnit: "usd", totalQuota: 100 })];
    const rows = [row({ providerId: "prov-a", apiCredentialId: "cred-a", cost: 30 })];
    const guard = await buildQuotaGuard([mPrimary], plans, rows);
    expect((await guard.getExhaustedModelIds()).size).toBe(0);
  });

  it("套餐绑定具体 apiCredential → 只匹配同 credential 的用量", async () => {
    const plans = [
      plan({ id: "plan-a", providerId: "prov-a", linkedApiCredentialId: "cred-a", quotaUnit: "usd", totalQuota: 50 }),
    ];
    // 用量挂在另一个 credential 上，不应算进 plan-a
    const rows = [row({ providerId: "prov-a", apiCredentialId: "cred-other", cost: 999 })];
    const guard = await buildQuotaGuard([mPrimary], plans, rows);
    expect((await guard.getExhaustedModelIds()).size).toBe(0);
  });

  it("无总额度的套餐永不饱和，不影响其他套餐的判定", async () => {
    const plans = [
      plan({ id: "plan-unlimited", providerId: "prov-a", quotaUnit: "usd", totalQuota: null }),
      plan({ id: "plan-b", providerId: "prov-b", quotaUnit: "usd", totalQuota: 10 }),
    ];
    const rows = [row({ providerId: "prov-b", apiCredentialId: "cred-b", cost: 20 })];
    const guard = await buildQuotaGuard([mPrimary, mFallback], plans, rows);
    const exhausted = await guard.getExhaustedModelIds();
    expect(exhausted.has("m-primary")).toBe(false);
    expect(exhausted.has("m-fallback")).toBe(true);
  });
});

// 2026-07-15 review 修复：stream-runtime.ts 的热路径（每次发消息都跑一遍）改用
// buildQuotaGuardFromAggregates，避免每次都把 usage_events 全表拉进 JS。这组测试用跟
// 上面 buildQuotaGuard 完全一样的场景断言两者判定结果一致——聚合版必须是原始版的等价
// 重写，换了输入形状不能换判定结果。
describe("buildQuotaGuardFromAggregates（跟 buildQuotaGuard 判定结果一致）", () => {
  const mPrimary: ModelEndpoint = {
    modelId: "m-primary",
    modelName: "primary",
    providerType: "anthropic",
    providerId: "prov-a",
    apiCredentialId: "cred-a",
    apiKey: "k",
    baseUrl: "https://x",
    displayLabel: "Primary",
  };
  const mFallback: ModelEndpoint = {
    modelId: "m-fallback",
    modelName: "fallback",
    providerType: "openai",
    providerId: "prov-b",
    apiCredentialId: "cred-b",
    apiKey: "k",
    baseUrl: "https://y",
    displayLabel: "Fallback",
  };

  function aggregate(a: Partial<UsageAggregateRow>): UsageAggregateRow {
    return {
      providerId: "prov-a",
      apiCredentialId: "cred-a",
      totalCost: 0,
      totalTokens: 0,
      recordedEvents: 0,
      unknownPricingCalls: 0,
      ...a,
    };
  }

  it("套餐额度耗尽 → 对应模型进入 exhausted 集合", async () => {
    const plans = [plan({ id: "plan-a", providerId: "prov-a", quotaUnit: "usd", totalQuota: 100 })];
    const aggregates = [aggregate({ providerId: "prov-a", apiCredentialId: "cred-a", totalCost: 120, recordedEvents: 1 })];
    const guard = await buildQuotaGuardFromAggregates([mPrimary, mFallback], plans, aggregates);
    const exhausted = await guard.getExhaustedModelIds();
    expect(exhausted.has("m-primary")).toBe(true);
    expect(exhausted.has("m-fallback")).toBe(false);
  });

  it("套餐额度未耗尽 → 不进入 exhausted 集合", async () => {
    const plans = [plan({ id: "plan-a", providerId: "prov-a", quotaUnit: "usd", totalQuota: 100 })];
    const aggregates = [aggregate({ totalCost: 30, recordedEvents: 1 })];
    const guard = await buildQuotaGuardFromAggregates([mPrimary], plans, aggregates);
    expect((await guard.getExhaustedModelIds()).size).toBe(0);
  });

  it("套餐绑定具体 apiCredential → 只匹配同 credential 的聚合行", async () => {
    const plans = [
      plan({ id: "plan-a", providerId: "prov-a", linkedApiCredentialId: "cred-a", quotaUnit: "usd", totalQuota: 50 }),
    ];
    const aggregates = [aggregate({ apiCredentialId: "cred-other", totalCost: 999, recordedEvents: 1 })];
    const guard = await buildQuotaGuardFromAggregates([mPrimary], plans, aggregates);
    expect((await guard.getExhaustedModelIds()).size).toBe(0);
  });
});
