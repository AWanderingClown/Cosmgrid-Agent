// usage-tracker 单测（v0.9 阶段7：role 落盘修复 — 不再写死 "main_chat"）
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

// db 的 usageEvents.create mock 掉，只验证传进去的 role
// 注意：usage-tracker 在 src/lib/llm/，引的是 "../db" = src/lib/db；
// 本测试在 __tests__/，故 mock 路径要多一层 "../../db"
vi.mock("../../db", () => ({
  usageEvents: { create: mocks.create },
}));
// 成本计算 mock 成固定值，隔离价格表
vi.mock("../cost-calculator", () => ({
  calculateCost: vi.fn(() => 0.001),
}));
// 模型表现统计是旁路，单测 usage-tracker 时 mock 掉，避免触达 db
vi.mock("../model-performance-stats", () => ({
  recordPerformanceSample: vi.fn(),
}));

import { recordUsageEvent, flushPendingWrites } from "../usage-tracker";

const baseParams = {
  modelId: "m-1",
  modelName: "test-model",
  providerId: "prov-1",
  apiCredentialId: "cred-1",
  usage: { inputTokens: 100, outputTokens: 50 },
  finishReason: "stop",
};

describe("recordUsageEvent — role 落盘", () => {
  beforeEach(() => {
    mocks.create.mockClear();
    mocks.create.mockResolvedValue(undefined);
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
      success: true,
    });
  });

  it("flushPendingWrites 等待未 await 的写入完成", async () => {
    recordUsageEvent({ ...baseParams, role: "simple" });
    await flushPendingWrites();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
