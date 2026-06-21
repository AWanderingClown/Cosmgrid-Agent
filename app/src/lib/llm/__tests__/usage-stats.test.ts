// usage-stats 单测（v0.9 阶段7：用量聚合）
import { describe, it, expect } from "vitest";
import { aggregateUsage, dayKey } from "../usage-stats";
import type { UsageEventRow } from "../../db";

const NOW = new Date("2026-06-22T12:00:00.000Z");

function ev(over: Partial<UsageEventRow> = {}): UsageEventRow {
  return {
    modelId: "m-1", role: "standard", inputTokens: 100, outputTokens: 50,
    cost: 0.01, success: true, createdAt: NOW.toISOString(), ...over,
  };
}

describe("dayKey", () => {
  it("格式 YYYY-MM-DD", () => {
    expect(dayKey(new Date("2026-06-09T05:00:00"))).toBe("2026-06-09");
  });
});

describe("aggregateUsage", () => {
  it("空输入：全 0，byDay 仍有 7 天", () => {
    const s = aggregateUsage([], NOW);
    expect(s.todayCost).toBe(0);
    expect(s.totalCalls).toBe(0);
    expect(s.byDay).toHaveLength(7);
    expect(s.byModel).toEqual([]);
  });

  it("今日成本累加", () => {
    const s = aggregateUsage([ev({ cost: 0.02 }), ev({ cost: 0.03 })], NOW);
    expect(s.todayCost).toBeCloseTo(0.05, 10);
    expect(s.totalCalls).toBe(2);
  });

  it("7 天 / 30 天窗口区分", () => {
    const old10d = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const old40d = new Date(NOW.getTime() - 40 * 86_400_000).toISOString();
    const s = aggregateUsage([
      ev({ cost: 0.01 }),                       // 今天
      ev({ cost: 0.02, createdAt: old10d }),    // 10 天前
      ev({ cost: 0.04, createdAt: old40d }),    // 40 天前
    ], NOW);
    expect(s.last7dCost).toBeCloseTo(0.01, 10);
    expect(s.last30dCost).toBeCloseTo(0.03, 10);
  });

  it("按模型聚合并按成本降序", () => {
    const s = aggregateUsage([
      ev({ modelId: "cheap", cost: 0.001 }),
      ev({ modelId: "pricey", cost: 0.05 }),
      ev({ modelId: "pricey", cost: 0.05 }),
    ], NOW);
    expect(s.byModel[0]!.modelId).toBe("pricey");
    expect(s.byModel[0]!.cost).toBeCloseTo(0.1, 10);
    expect(s.byModel[0]!.calls).toBe(2);
    expect(s.byModel[1]!.modelId).toBe("cheap");
  });

  it("byDay 含 0 成本日且升序", () => {
    const s = aggregateUsage([ev({ cost: 0.01 })], NOW);
    expect(s.byDay).toHaveLength(7);
    expect(s.byDay[0]!.date < s.byDay[6]!.date).toBe(true);
    const today = s.byDay.find((d) => d.date === dayKey(NOW));
    expect(today!.cost).toBeCloseTo(0.01, 10);
  });

  it("modelId 为 null 归到 (unknown)", () => {
    const s = aggregateUsage([ev({ modelId: null })], NOW);
    expect(s.byModel[0]!.modelId).toBe("(unknown)");
  });

  it("非法日期跳过不崩", () => {
    const s = aggregateUsage([ev({ createdAt: "not-a-date", cost: 9 })], NOW);
    expect(s.last30dCost).toBe(0);
  });
});
