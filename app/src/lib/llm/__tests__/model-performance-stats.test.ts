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
  MIN_SAMPLES_FOR_SCORING,
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

describe("isScoreEligible", () => {
  it(`sampleCount >= ${MIN_SAMPLES_FOR_SCORING} 才可评分`, () => {
    expect(isScoreEligible(null)).toBe(false);
    expect(isScoreEligible({ sampleCount: MIN_SAMPLES_FOR_SCORING - 1 } as ModelPerfStat)).toBe(false);
    expect(isScoreEligible({ sampleCount: MIN_SAMPLES_FOR_SCORING } as ModelPerfStat)).toBe(true);
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
