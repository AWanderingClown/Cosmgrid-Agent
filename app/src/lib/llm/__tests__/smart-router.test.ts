// smart-router 单测（v0.9 阶段7：评分 + 配额降级 + v1 降级）
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../../db", () => ({
  modelPerformanceStats: { list: mocks.list },
}));

import { scoreCandidates, routeMessage, QUOTA_LOW_RATIO } from "../smart-router";
import type { ModelPerformanceStatRow } from "../../db";

function stat(over: Partial<ModelPerformanceStatRow> = {}): ModelPerformanceStatRow {
  return {
    modelId: "m", taskType: "standard", successRate: 1, avgInputTokens: 100,
    avgOutputTokens: 50, avgCost: 0.01, avgLatencyMs: 1000, sampleCount: 50,
    windowStart: "", windowEnd: "", ...over,
  };
}

// RoutableModel 形状：需 name（判档）+ id；这里给最小必要字段
function model(id: string, name = "claude-sonnet-4-6") {
  return { id, name, capabilityScore: {} } as any;
}

describe("scoreCandidates（纯函数）", () => {
  it("成功率高的分更高", () => {
    const s = scoreCandidates([
      { modelId: "a", stat: stat({ successRate: 1, avgCost: 0.01, avgLatencyMs: 1000 }) },
      { modelId: "b", stat: stat({ successRate: 0.5, avgCost: 0.01, avgLatencyMs: 1000 }) },
    ]);
    expect(s[0]!.modelId).toBe("a");
  });

  it("同成功率下更便宜的分更高", () => {
    const s = scoreCandidates([
      { modelId: "cheap", stat: stat({ avgCost: 0.001 }) },
      { modelId: "pricey", stat: stat({ avgCost: 0.05 }) },
    ]);
    expect(s[0]!.modelId).toBe("cheap");
  });

  it("空输入返回空", () => {
    expect(scoreCandidates([])).toEqual([]);
  });

  it("返回按分降序", () => {
    const s = scoreCandidates([
      { modelId: "a", stat: stat({ successRate: 0.7 }) },
      { modelId: "b", stat: stat({ successRate: 0.9 }) },
    ]);
    expect(s[0]!.score).toBeGreaterThanOrEqual(s[1]!.score);
  });
});

describe("routeMessage", () => {
  beforeEach(() => mocks.list.mockReset());
  // 统一传 ctx.taskType=standard，避免依赖文本难度分类
  const CTX = { taskType: "standard" as const };

  it("models 为空 → null", async () => {
    mocks.list.mockResolvedValue([]);
    expect(await routeMessage("hi", [])).toBeNull();
  });

  it("样本不足 → v1 降级", async () => {
    mocks.list.mockResolvedValue([stat({ modelId: "a", sampleCount: 5 })]); // < 30
    const r = await routeMessage("帮我设计架构", [model("a"), model("b")], CTX);
    expect(r!.decisionLog.strategy).toBe("v1-fallback");
  });

  it("无任何统计 → v1 降级", async () => {
    mocks.list.mockResolvedValue([]);
    const r = await routeMessage("普通问题", [model("a")], CTX);
    expect(r!.decisionLog.strategy).toBe("v1-fallback");
  });

  it("够样本 → 评分路由，选分最高", async () => {
    mocks.list.mockResolvedValue([
      stat({ modelId: "good", successRate: 1, avgCost: 0.001 }),
      stat({ modelId: "bad", successRate: 0.4, avgCost: 0.05 }),
    ]);
    const r = await routeMessage("解释概念", [model("good"), model("bad")], CTX);
    expect(r!.decisionLog.strategy).toBe("scored");
    expect(r!.decisionLog.chosenModelId).toBe("good");
  });

  it("首选配额将尽且有次优 → 降级", async () => {
    mocks.list.mockResolvedValue([
      stat({ modelId: "top", successRate: 1, avgCost: 0.001 }),
      stat({ modelId: "alt", successRate: 0.95, avgCost: 0.002 }),
    ]);
    const r = await routeMessage("xx", [model("top"), model("alt")], {
      ...CTX, quotaByModelId: { top: QUOTA_LOW_RATIO - 0.01, alt: 1 },
    });
    expect(r!.decisionLog.strategy).toBe("scored-quota-downgrade");
    expect(r!.decisionLog.chosenModelId).toBe("alt");
  });

  it("候选配额全耗尽 → v1 降级", async () => {
    mocks.list.mockResolvedValue([
      stat({ modelId: "a", sampleCount: 50 }),
      stat({ modelId: "b", sampleCount: 50 }),
    ]);
    const r = await routeMessage("xx", [model("a"), model("b")], {
      ...CTX, quotaByModelId: { a: 0, b: 0 },
    });
    expect(r!.decisionLog.strategy).toBe("v1-fallback");
  });

  it("DecisionLog 带 reasons + scores", async () => {
    mocks.list.mockResolvedValue([stat({ modelId: "a", sampleCount: 50 })]);
    const r = await routeMessage("xx", [model("a")], CTX);
    expect(r!.decisionLog.reasons.length).toBeGreaterThan(0);
    expect(Array.isArray(r!.decisionLog.scores)).toBe(true);
  });
});
