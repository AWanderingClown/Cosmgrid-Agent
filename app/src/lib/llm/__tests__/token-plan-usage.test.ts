import { describe, expect, it } from "vitest";
import { computeTokenPlanUsage } from "../token-plan-usage";
import type { TokenPlan, UsageEventRow } from "../../db";

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
