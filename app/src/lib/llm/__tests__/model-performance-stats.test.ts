// model-performance-stats 单测（v0.9 阶段7：增量滚动均值 + 评分门槛）
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("../../db", () => ({
  modelPerformanceStats: { get: mocks.get, upsert: mocks.upsert },
}));

import {
  mergeSample,
  isScoreEligible,
  recordPerformanceSample,
  recordOutcomeSignal,
  shrinkSuccessRate,
  MIN_SAMPLES_FOR_SCORING,
  PRIOR_PSEUDO_COUNT,
  DEFAULT_PRIOR_SUCCESS_RATE,
  type ModelPerfStat,
  type PerfSample,
} from "../model-performance-stats";

const TS = "2026-06-22T00:00:00.000Z";

function sample(over: Partial<PerfSample> = {}): PerfSample {
  return { inputTokens: 100, outputTokens: 50, cost: 0.01, latencyMs: 1000, success: true, ...over };
}

describe("mergeSample — 首样本", () => {
  it("prev=null 时直接用样本值初始化，sampleCount=1", () => {
    const s = mergeSample(null, sample(), "m-1", "hard", TS);
    expect(s).toMatchObject({
      modelId: "m-1",
      taskType: "hard",
      successRate: 1,
      avgInputTokens: 100,
      avgOutputTokens: 50,
      avgCost: 0.01,
      avgLatencyMs: 1000,
      sampleCount: 1,
      windowStart: TS,
      windowEnd: TS,
    });
  });

  it("success=false 首样本 successRate=0", () => {
    const s = mergeSample(null, sample({ success: false }), "m-1", "hard", TS);
    expect(s.successRate).toBe(0);
  });
});

describe("mergeSample — 增量均值正确性", () => {
  it("两个样本 cost 取平均", () => {
    const s1 = mergeSample(null, sample({ cost: 0.02 }), "m-1", "hard", TS);
    const s2 = mergeSample(s1, sample({ cost: 0.04 }), "m-1", "hard", TS);
    expect(s2.avgCost).toBeCloseTo(0.03, 10);
    expect(s2.sampleCount).toBe(2);
  });

  it("successRate 反映成功比例（3 成功 1 失败 = 0.75）", () => {
    let s: ModelPerfStat | null = null;
    for (const ok of [true, true, true, false]) {
      s = mergeSample(s, sample({ success: ok }), "m-1", "standard", TS);
    }
    expect(s!.successRate).toBeCloseTo(0.75, 10);
    expect(s!.sampleCount).toBe(4);
  });

  it("avgInputTokens 滚动均值（100,200,300 → 200）", () => {
    let s: ModelPerfStat | null = null;
    for (const tk of [100, 200, 300]) {
      s = mergeSample(s, sample({ inputTokens: tk }), "m-1", "simple", TS);
    }
    expect(s!.avgInputTokens).toBeCloseTo(200, 10);
  });

  it("windowStart 保持首样本时间，windowEnd 更新到最新", () => {
    const s1 = mergeSample(null, sample(), "m-1", "hard", "2026-06-20T00:00:00.000Z");
    const s2 = mergeSample(s1, sample(), "m-1", "hard", "2026-06-22T00:00:00.000Z");
    expect(s2.windowStart).toBe("2026-06-20T00:00:00.000Z");
    expect(s2.windowEnd).toBe("2026-06-22T00:00:00.000Z");
  });

  it("latencyMs 缺省按 0 计入", () => {
    const s = mergeSample(null, sample({ latencyMs: undefined }), "m-1", "hard", TS);
    expect(s.avgLatencyMs).toBe(0);
  });
});

describe("isScoreEligible — 冷启动死锁修复后门槛=1", () => {
  it("门槛已从 30 降到 1（跑过 1 次即可评分）", () => {
    expect(MIN_SAMPLES_FOR_SCORING).toBe(1);
  });

  it(`sampleCount >= ${MIN_SAMPLES_FOR_SCORING} 才可评分；0 次（含 null）回落 v1`, () => {
    expect(isScoreEligible(null)).toBe(false);
    expect(isScoreEligible({ sampleCount: 0 } as ModelPerfStat)).toBe(false);
    expect(isScoreEligible({ sampleCount: 1 } as ModelPerfStat)).toBe(true);
    expect(isScoreEligible({ sampleCount: 50 } as ModelPerfStat)).toBe(true);
  });
});

describe("shrinkSuccessRate — 贝叶斯收缩防小样本过拟合", () => {
  it("0 样本 → 完全等于先验", () => {
    expect(shrinkSuccessRate(1, 0)).toBeCloseTo(DEFAULT_PRIOR_SUCCESS_RATE, 10);
  });

  it("1 次成功（rawRate=1）被拉向先验，不会满分", () => {
    const shrunk = shrinkSuccessRate(1, 1);
    // (0.7*8 + 1*1) / (8+1) = 6.6/9 ≈ 0.733
    expect(shrunk).toBeCloseTo((DEFAULT_PRIOR_SUCCESS_RATE * PRIOR_PSEUDO_COUNT + 1) / (PRIOR_PSEUDO_COUNT + 1), 10);
    expect(shrunk).toBeLessThan(1);
    expect(shrunk).toBeGreaterThan(DEFAULT_PRIOR_SUCCESS_RATE);
  });

  it("大样本（n≫k）几乎等于实测率", () => {
    expect(shrinkSuccessRate(0.95, 1000)).toBeCloseTo(0.95, 2);
  });

  it("1 次失败（rawRate=0）被先验上托，不会归零", () => {
    const shrunk = shrinkSuccessRate(0, 1);
    expect(shrunk).toBeGreaterThan(0);
    expect(shrunk).toBeLessThan(DEFAULT_PRIOR_SUCCESS_RATE);
  });

  it("自定义先验与伪计数生效", () => {
    expect(shrinkSuccessRate(1, 2, 0.5, 2)).toBeCloseTo((0.5 * 2 + 1 * 2) / 4, 10);
  });
});

describe("recordPerformanceSample — db 读改写", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue(undefined);
  });

  it("首次：get 返回 null → upsert 写入 sampleCount=1", async () => {
    mocks.get.mockResolvedValue(null);
    await recordPerformanceSample("m-1", "hard", sample());
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls[0]![0]).toMatchObject({ modelId: "m-1", taskType: "hard", sampleCount: 1 });
  });

  it("已有统计：合并后 sampleCount 累加", async () => {
    mocks.get.mockResolvedValue({
      modelId: "m-1", taskType: "hard", successRate: 1, avgInputTokens: 100,
      avgOutputTokens: 50, avgCost: 0.01, avgLatencyMs: 1000, sampleCount: 5,
      windowStart: TS, windowEnd: TS,
    });
    await recordPerformanceSample("m-1", "hard", sample());
    expect(mocks.upsert.mock.calls[0]![0]).toMatchObject({ sampleCount: 6 });
  });

  it("db 报错不抛（统计是旁路）", async () => {
    mocks.get.mockRejectedValue(new Error("db down"));
    await expect(recordPerformanceSample("m-1", "hard", sample())).resolves.toBeUndefined();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe("recordOutcomeSignal — 隐式反馈只动成功率，不污染成本/延迟", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue(undefined);
  });

  const base: ModelPerfStat = {
    modelId: "m-1", taskType: "hard", successRate: 0.8, avgInputTokens: 100,
    avgOutputTokens: 50, avgCost: 0.02, avgLatencyMs: 1200, sampleCount: 10,
    windowStart: TS, windowEnd: TS,
  };

  it("无基线（prev=null）→ 不写（不凭空造数据）", async () => {
    mocks.get.mockResolvedValue(null);
    await recordOutcomeSignal("m-1", "hard", false);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("负反馈拉低成功率，但成本/延迟均值不变", async () => {
    mocks.get.mockResolvedValue(base);
    await recordOutcomeSignal("m-1", "hard", false);
    const written = mocks.upsert.mock.calls[0]![0];
    expect(written.successRate).toBeLessThan(base.successRate);
    expect(written.avgCost).toBeCloseTo(base.avgCost, 10);
    expect(written.avgLatencyMs).toBeCloseTo(base.avgLatencyMs, 10);
    expect(written.sampleCount).toBe(11);
  });

  it("正反馈拉高成功率", async () => {
    mocks.get.mockResolvedValue(base);
    await recordOutcomeSignal("m-1", "hard", true);
    expect(mocks.upsert.mock.calls[0]![0].successRate).toBeGreaterThan(base.successRate);
  });

  it("db 报错不抛", async () => {
    mocks.get.mockRejectedValue(new Error("boom"));
    await expect(recordOutcomeSignal("m-1", "hard", false)).resolves.toBeUndefined();
  });
});
