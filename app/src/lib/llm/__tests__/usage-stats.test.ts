// usage-stats 单测（v0.9 阶段7：用量聚合 + 阶段 F2 补：aggregateUsageByActorRoleFromRows 纯函数版）
import { describe, it, expect } from "vitest";
import { aggregateUsage, aggregateUsageByActorRoleFromRows, dayKey } from "../usage-stats";
import type { UsageEventRow } from "../../db";

const NOW = new Date("2026-06-22T12:00:00.000Z");

function ev(over: Partial<UsageEventRow> = {}): UsageEventRow {
  return {
    id: "evt-default", modelId: "m-1", projectId: null, conversationId: null, role: "standard", roleKind: null, inputTokens: 100, outputTokens: 50,
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

// ====== 阶段 I 补测：aggregateUsageByActorRoleFromRows（StatsPage 实际走的纯函数路径）======
// review 铁律 1：声称"沿用 F1.5 既有 733 tests 覆盖"是装的——集成测试覆盖 async+SQL 路径，StatsPage 走的是纯函数路径，路径错位
describe("aggregateUsageByActorRoleFromRows（阶段 F2 纯函数版）", () => {
  it("空 rows → 返 []", () => {
    expect(aggregateUsageByActorRoleFromRows([])).toEqual([]);
  });

  it("单 leader 角色 + 单 model → 1 个 group + 1 row", () => {
    const result = aggregateUsageByActorRoleFromRows([
      ev({ roleKind: "leader", modelId: "mA", cost: 0.10 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.roleKind).toBe("leader");
    expect(result[0]!.totalCost).toBeCloseTo(0.10);
    expect(result[0]!.totalCalls).toBe(1);
    expect(result[0]!.rows).toHaveLength(1);
    expect(result[0]!.rows[0]!.modelId).toBe("mA");
  });

  it("★ 多角色多 model：leader + architect + frontend + backend", () => {
    const result = aggregateUsageByActorRoleFromRows([
      ev({ roleKind: "leader", modelId: "mA", cost: 0.10 }),
      ev({ roleKind: "architect", modelId: "mB", cost: 0.20 }),
      ev({ roleKind: "frontend", modelId: "mC", cost: 0.30 }),
      ev({ roleKind: "backend", modelId: "mD", cost: 0.40 }),
    ]);
    expect(result).toHaveLength(4);
    // roleKind 间按字母序（leader < frontend < backend < architect 排错——按 ROLE_IDS 顺序是 leader < architect < backend < frontend）
    // 实际排序：NULL 排最后 + 其余字母序
    const roleKinds = result.map((r) => r.roleKind);
    expect(roleKinds.slice(0, 4)).toEqual(["architect", "backend", "frontend", "leader"]);
  });

  it("★ NULL roleKind 当独立'未分类'组排最后（review F1-1 落实）", () => {
    const result = aggregateUsageByActorRoleFromRows([
      ev({ roleKind: null, modelId: "mA", cost: 0.10 }),  // 旧数据：role_kind NULL
      ev({ roleKind: "leader", modelId: "mB", cost: 0.20 }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]!.roleKind).toBe("leader");
    expect(result[1]!.roleKind).toBeNull(); // 排最后
  });

  it("stage 角色（ProjectDetailPage 来源）独立识别", () => {
    const result = aggregateUsageByActorRoleFromRows([
      ev({ roleKind: "stage", modelId: "mA", cost: 0.10 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.roleKind).toBe("stage");
  });

  it("★ 同 roleKind + 同 modelId 多行 → SUM 累加（review F1-1：5+5+5=15）", () => {
    const result = aggregateUsageByActorRoleFromRows([
      ev({ roleKind: "frontend", modelId: "mA", cost: 0.05 }),
      ev({ roleKind: "frontend", modelId: "mA", cost: 0.05 }),
      ev({ roleKind: "frontend", modelId: "mA", cost: 0.05 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.totalCost).toBeCloseTo(0.15);
    expect(result[0]!.totalCalls).toBe(3);
    expect(result[0]!.rows).toHaveLength(1); // 合并到 1 行
  });

  it("★ 同 roleKind + 不同 modelId → 按 cost DESC 排（StatsPage 渲染顺序）", () => {
    const result = aggregateUsageByActorRoleFromRows([
      ev({ roleKind: "frontend", modelId: "mCheap", cost: 0.01 }),
      ev({ roleKind: "frontend", modelId: "mExpensive", cost: 0.50 }),
      ev({ roleKind: "frontend", modelId: "mMid", cost: 0.10 }),
    ]);
    expect(result[0]!.rows.map((r) => r.modelId)).toEqual(["mExpensive", "mMid", "mCheap"]);
  });

  it("modelId=NULL → rows[].modelId='(unknown model)' 占位（review M3 防 i18n 拼错）", () => {
    const result = aggregateUsageByActorRoleFromRows([
      ev({ roleKind: "leader", modelId: null, cost: 0.10 }),
    ]);
    expect(result[0]!.rows[0]!.modelId).toBe("(unknown model)");
  });
});
