// usage-tracker 单测（v0.9 阶段7：role 落盘修复 — 不再写死 "main_chat"）
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  savingsCreate: vi.fn(),
}));

// db 的 usageEvents.create mock 掉，只验证传进去的 role
// 注意：usage-tracker 在 src/lib/llm/，引的是 "../db" = src/lib/db；
// 本测试在 __tests__/，故 mock 路径要多一层 "../../db"
vi.mock("../../db", () => ({
  usageEvents: { create: mocks.create },
  savingsEvents: { create: mocks.savingsCreate },
}));
// 成本计算 mock 成固定值，隔离价格表
vi.mock("../cost-calculator", () => ({
  estimateCostWithCatalog: vi.fn(() => ({
    cost: 0.001,
    pricingKnown: true,
    priceCatalogId: "price-actual",
    priceVersion: "test-version",
    priceSource: "builtin",
    priceSourceUrl: "builtin:test",
    resolvedPrice: null,
  })),
}));
// 模型表现统计是旁路，单测 usage-tracker 时 mock 掉，避免触达 db
vi.mock("../model-performance-stats", () => ({
  recordPerformanceSample: vi.fn(),
}));

import { recordUsageEvent, flushPendingWrites } from "../usage-tracker";
import { estimateCostWithCatalog } from "../cost-calculator";

const baseParams = {
  modelId: "m-1",
  modelName: "test-model",
  providerType: "openai",
  providerId: "prov-1",
  apiCredentialId: "cred-1",
  usage: { inputTokens: 100, outputTokens: 50 },
  finishReason: "stop",
};

describe("recordUsageEvent — role 落盘", () => {
  beforeEach(() => {
    mocks.create.mockClear();
    mocks.create.mockResolvedValue("usage-1");
    mocks.savingsCreate.mockClear();
    mocks.savingsCreate.mockResolvedValue(undefined);
  });

  it("传入 role 时按传入值落盘（不再写死 main_chat）", async () => {
    await recordUsageEvent({ ...baseParams, role: "hard" }, { awaitWrite: true });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ role: "hard" });
  });

  it("不传 role 时兜底为 main_chat（向后兼容）", async () => {
    await recordUsageEvent(baseParams, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ role: "main_chat" });
  });

  it("role 取值覆盖三种 complexity 桶", async () => {
    for (const role of ["simple", "standard", "hard"] as const) {
      mocks.create.mockClear();
      await recordUsageEvent({ ...baseParams, role }, { awaitWrite: true });
      expect(mocks.create.mock.calls[0]![0]).toMatchObject({ role });
    }
  });

  it("token / cost / success 仍正确透传", async () => {
    await recordUsageEvent({ ...baseParams, role: "standard" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      modelId: "m-1",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
      pricingKnown: true,
      priceCatalogId: "price-actual",
      success: true,
    });
  });

  it("查价时传 providerType，避免同名模型跨 provider 错价", async () => {
    await recordUsageEvent({ ...baseParams, providerType: "openai-compatible" }, { awaitWrite: true });
    expect(estimateCostWithCatalog).toHaveBeenCalledWith(
      "test-model",
      { inputTokens: 100, outputTokens: 50 },
      "openai-compatible",
    );
  });

  it("finishReason=end_turn 也算正常调用，避免 CLI 正常结束被误判为不稳定", async () => {
    await recordUsageEvent({ ...baseParams, finishReason: "end_turn" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      success: true,
    });
  });

  it("finishReason=length 不算正常调用", async () => {
    await recordUsageEvent({ ...baseParams, finishReason: "length" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      success: false,
    });
  });

  it("flushPendingWrites 等待未 await 的写入完成", async () => {
    recordUsageEvent({ ...baseParams, role: "simple" });
    await flushPendingWrites();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});

describe("阶段 F1 H3：roleKind 透传 + spread 守门（review F1-7）", () => {
  beforeEach(() => {
    mocks.create.mockClear();
    mocks.create.mockResolvedValue("usage-1");
    mocks.savingsCreate.mockClear();
    mocks.savingsCreate.mockResolvedValue(undefined);
  });

  it("roleKind='frontend' → usageEvents.create 入参含 roleKind='frontend'", async () => {
    await recordUsageEvent({ ...baseParams, roleKind: "frontend" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ roleKind: "frontend" });
  });

  it("roleKind=undefined → 入参对象不含 roleKind 字段（spread 守门，让 db 层 ?? null 兜底）", async () => {
    await recordUsageEvent(baseParams, { awaitWrite: true });
    const calledArg = mocks.create.mock.calls[0]![0] as Record<string, unknown>;
    expect("roleKind" in calledArg).toBe(false);
  });

  it("roleKind=null → 入参 roleKind=null（明确归'未分类'组，区别于 undefined）", async () => {
    await recordUsageEvent({ ...baseParams, roleKind: null }, { awaitWrite: true });
    const calledArg = mocks.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(calledArg.roleKind).toBeNull();
  });

  it("roleKind='stage' → 入参含 roleKind='stage'（stage 不是 RoleId，是合法 actor_role 值）", async () => {
    await recordUsageEvent({ ...baseParams, roleKind: "stage" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ roleKind: "stage" });
  });

  it("role 和 roleKind 同存不互相覆盖（两者独立维度）", async () => {
    await recordUsageEvent(
      { ...baseParams, role: "hard", roleKind: "frontend" },
      { awaitWrite: true },
    );
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      role: "hard",        // workRole 难度桶：不变
      roleKind: "frontend", // 阶段 F1 新增：actor 维度
    });
  });
});
