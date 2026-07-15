import { describe, expect, it } from "vitest";
import { computeTokenPlanUsage, computeTokenPlanUsageFromAggregates } from "../token-plan-usage";
import type { TokenPlan, UsageAggregateRow, UsageEventRow } from "../../db";

const PLAN: TokenPlan = {
  id: "plan-1",
  providerId: "provider-1",
  linkedApiCredentialId: null,
  name: "Plan",
  planType: "monthly",
  quotaUnit: "usd",
  totalQuota: 100,
  usedQuota: 7,
  resetRule: null,
  nextResetAt: null,
  warningThresholds: null,
  status: "active",
  autoTrackEnabled: false,
  manualUpdateRequired: false,
  fallbackModelId: null,
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z",
};

function row(over: Partial<UsageEventRow> = {}): UsageEventRow {
  return {
    id: "evt-1",
    providerId: "provider-1",
    apiCredentialId: "cred-1",
    modelId: "model-1",
    projectId: null,
    conversationId: null,
    role: "main_chat",
    roleKind: "leader",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheHitTokens: 20,
    cost: 0.03,
    pricingKnown: true,
    priceVersion: null,
    priceSource: null,
    priceCatalogId: null,
    success: true,
    createdAt: "2026-06-28T00:00:00.000Z",
    ...over,
  };
}

describe("computeTokenPlanUsage", () => {
  it("usd 套餐按同 provider 的真实成本汇总", () => {
    const snapshot = computeTokenPlanUsage(PLAN, [
      row({ cost: 0.03 }),
      row({ cost: 0.02 }),
      row({ providerId: "other", cost: 9 }),
    ]);
    expect(snapshot.source).toBe("recorded");
    expect(snapshot.usedQuota).toBeCloseTo(0.05);
    expect(snapshot.recordedEvents).toBe(2);
  });

  it("token 套餐按 input/output/cache token 汇总", () => {
    const snapshot = computeTokenPlanUsage({ ...PLAN, quotaUnit: "token" }, [
      row({ inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheHitTokens: 20 }),
    ]);
    expect(snapshot.usedQuota).toBe(180);
  });

  it("request 和 message 套餐按调用次数汇总", () => {
    expect(computeTokenPlanUsage({ ...PLAN, quotaUnit: "request" }, [row(), row()]).usedQuota).toBe(2);
    expect(computeTokenPlanUsage({ ...PLAN, quotaUnit: "message" }, [row(), row(), row()]).usedQuota).toBe(3);
  });

  it("绑定具体 API 凭证时只统计该凭证", () => {
    const snapshot = computeTokenPlanUsage({ ...PLAN, linkedApiCredentialId: "cred-2" }, [
      row({ apiCredentialId: "cred-1", cost: 9 }),
      row({ apiCredentialId: "cred-2", cost: 0.04 }),
    ]);
    expect(snapshot.usedQuota).toBeCloseTo(0.04);
    expect(snapshot.recordedEvents).toBe(1);
  });

  it("usd 套餐保留未知价格调用数，提示成本可能偏低", () => {
    const snapshot = computeTokenPlanUsage(PLAN, [
      row({ pricingKnown: false, cost: 0 }),
      row({ pricingKnown: true, cost: 0.02 }),
    ]);
    expect(snapshot.unknownPricingCalls).toBe(1);
    expect(snapshot.usedQuota).toBeCloseTo(0.02);
  });

  it("time 等无法从本地日志自动推断的单位回退到手填值", () => {
    const snapshot = computeTokenPlanUsage({ ...PLAN, quotaUnit: "time", usedQuota: 12 }, [row()]);
    expect(snapshot.source).toBe("manual");
    expect(snapshot.autoTrackable).toBe(false);
    expect(snapshot.usedQuota).toBe(12);
  });
});

// 2026-07-15 review 修复：quota guard 热路径改走 SQL 侧 GROUP BY 聚合而不是拉全表原始
// 记录到 JS reduce（见 usage-events.ts 的 aggregateByProviderCredential）。这组测试锁定
// computeTokenPlanUsageFromAggregates 跟上面 computeTokenPlanUsage 算出同样的结果——
// 聚合版必须是原始版的等价重写，不能因为换了输入形状就算出不同的耗尽判定。
function aggregate(over: Partial<UsageAggregateRow> = {}): UsageAggregateRow {
  return {
    providerId: "provider-1",
    apiCredentialId: "cred-1",
    totalCost: 0,
    totalTokens: 0,
    recordedEvents: 0,
    unknownPricingCalls: 0,
    ...over,
  };
}

describe("computeTokenPlanUsageFromAggregates（跟 computeTokenPlanUsage 等价）", () => {
  it("usd 套餐按同 provider 的聚合成本汇总，不匹配 provider 的聚合行被排除", () => {
    const snapshot = computeTokenPlanUsageFromAggregates(PLAN, [
      aggregate({ totalCost: 0.05, recordedEvents: 2 }),
      aggregate({ providerId: "other", totalCost: 9, recordedEvents: 1 }),
    ]);
    expect(snapshot.source).toBe("recorded");
    expect(snapshot.usedQuota).toBeCloseTo(0.05);
    expect(snapshot.recordedEvents).toBe(2);
  });

  it("token 套餐按聚合的 total_tokens 汇总", () => {
    const snapshot = computeTokenPlanUsageFromAggregates(
      { ...PLAN, quotaUnit: "token" },
      [aggregate({ totalTokens: 180 })],
    );
    expect(snapshot.usedQuota).toBe(180);
  });

  it("request 和 message 套餐按聚合的 recordedEvents 汇总", () => {
    expect(
      computeTokenPlanUsageFromAggregates({ ...PLAN, quotaUnit: "request" }, [
        aggregate({ recordedEvents: 2 }),
      ]).usedQuota,
    ).toBe(2);
    expect(
      computeTokenPlanUsageFromAggregates({ ...PLAN, quotaUnit: "message" }, [
        aggregate({ recordedEvents: 3 }),
      ]).usedQuota,
    ).toBe(3);
  });

  it("绑定具体 API 凭证时只统计该凭证的聚合行", () => {
    const snapshot = computeTokenPlanUsageFromAggregates({ ...PLAN, linkedApiCredentialId: "cred-2" }, [
      aggregate({ apiCredentialId: "cred-1", totalCost: 9, recordedEvents: 5 }),
      aggregate({ apiCredentialId: "cred-2", totalCost: 0.04, recordedEvents: 1 }),
    ]);
    expect(snapshot.usedQuota).toBeCloseTo(0.04);
    expect(snapshot.recordedEvents).toBe(1);
  });

  it("usd 套餐保留未知价格调用数", () => {
    const snapshot = computeTokenPlanUsageFromAggregates(PLAN, [
      aggregate({ totalCost: 0.02, recordedEvents: 2, unknownPricingCalls: 1 }),
    ]);
    expect(snapshot.unknownPricingCalls).toBe(1);
    expect(snapshot.usedQuota).toBeCloseTo(0.02);
  });

  it("time 等无法自动推断的单位回退到手填值，不看聚合数据", () => {
    const snapshot = computeTokenPlanUsageFromAggregates(
      { ...PLAN, quotaUnit: "time", usedQuota: 12 },
      [aggregate({ totalCost: 999 })],
    );
    expect(snapshot.source).toBe("manual");
    expect(snapshot.autoTrackable).toBe(false);
    expect(snapshot.usedQuota).toBe(12);
  });

  it("跟 computeTokenPlanUsage 在同一份数据下算出完全相同的结果（等价性锁定）", () => {
    const rows = [
      row({ cost: 0.03, inputTokens: 100, outputTokens: 50 }),
      row({ cost: 0.02, inputTokens: 80, outputTokens: 40 }),
      row({ providerId: "other", cost: 9 }),
    ];
    const aggregates: UsageAggregateRow[] = [
      { providerId: "provider-1", apiCredentialId: "cred-1", totalCost: 0.05, totalTokens: 100 + 50 + 10 + 20 + 80 + 40 + 10 + 20, recordedEvents: 2, unknownPricingCalls: 0 },
      { providerId: "other", apiCredentialId: "cred-1", totalCost: 9, totalTokens: 0, recordedEvents: 1, unknownPricingCalls: 0 },
    ];

    const fromRows = computeTokenPlanUsage(PLAN, rows);
    const fromAggregates = computeTokenPlanUsageFromAggregates(PLAN, aggregates);

    expect(fromAggregates.usedQuota).toBeCloseTo(fromRows.usedQuota);
    expect(fromAggregates.recordedEvents).toBe(fromRows.recordedEvents);
  });
});
