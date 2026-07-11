// Harness 阶段4 — metrics + compare 单测。

import { describe, expect, it } from "vitest";
import { aggregateEvalMetrics } from "../metrics";
import { diffEvalRuns, type EvalRunSnapshot } from "../compare";
import type { EvalResult, EvalMetrics } from "../types";

function attemptOf(over: Partial<EvalResult>): EvalResult {
  return {
    id: "a-1", runId: "r-1", taskId: "c-1", attemptIndex: 0,
    passed: null, attemptCostUsd: 0, attemptLatencyMs: 0,
    interventionsCount: 0, ...over,
  };
}

describe("aggregateEvalMetrics: 11 指标", () => {
  it("全 0 attempts → zeroMetrics", () => {
    const m = aggregateEvalMetrics([]);
    expect(m.completionRate).toBe(0);
    expect(m.costPerSuccess).toBe(0);
  });

  it("3 cases: 2 通过 + 1 失败 → completionRate=2/3", () => {
    const m = aggregateEvalMetrics([
      attemptOf({ taskId: "c1", passed: true, attemptCostUsd: 0.1, attemptLatencyMs: 1000 }),
      attemptOf({ taskId: "c2", passed: true, attemptCostUsd: 0.2, attemptLatencyMs: 2000 }),
      attemptOf({ taskId: "c3", passed: false, failureCode: "TEST_FAILED" }),
    ]);
    expect(m.completionRate).toBeCloseTo(2 / 3, 5);
    expect(m.passAt1).toBeCloseTo(2 / 3, 5);
    expect(m.costPerSuccess).toBeCloseTo(0.15, 5);
  });

  it("pass_at_3：case 第 2 次 attempt 成功 → passAt3 应该 pass", () => {
    const m = aggregateEvalMetrics([
      attemptOf({ taskId: "c1", attemptIndex: 0, passed: false, failureCode: "TEST_FAILED" }),
      attemptOf({ taskId: "c1", attemptIndex: 1, passed: true }),
    ]);
    expect(m.completionRate).toBe(1);
    expect(m.passAt1).toBe(0);  // 第 0 次失败
    expect(m.passAt3).toBe(1);  // 第 1 次通过
  });

  it("harness_violation_rate：failureCode 含 TOOL_ 算 violation", () => {
    const m = aggregateEvalMetrics([
      attemptOf({ failureCode: "TOOL_DENIED" }),
      attemptOf({ failureCode: "TEST_FAILED" }),  // 不算 violation
      attemptOf({ failureCode: "EVIDENCE_INSUFFICIENT" }),
    ]);
    expect(m.harnessViolationRate).toBeCloseTo(2 / 3, 5);
  });

  it("human_interventions：needs_user + blocked 计入", () => {
    const m = aggregateEvalMetrics([
      attemptOf({ failureCode: "needs_user" }),
      attemptOf({ failureCode: "blocked" }),
      attemptOf({ failureCode: "FAILED" }),  // 不算
    ]);
    expect(m.humanInterventions).toBe(2);
  });

  it("retries_per_task = avg(attempts per case)", () => {
    const m = aggregateEvalMetrics([
      attemptOf({ taskId: "c1", attemptIndex: 0 }),
      attemptOf({ taskId: "c1", attemptIndex: 1 }),
      attemptOf({ taskId: "c1", attemptIndex: 2 }),
      attemptOf({ taskId: "c2", attemptIndex: 0 }),
    ]);
    expect(m.retriesPerTask).toBeCloseTo(2, 5);  // (3+1)/2
  });
});

describe("diffEvalRuns: 比较两次 run", () => {
  function snapOf(metrics: Partial<EvalMetrics>): EvalRunSnapshot {
    const base: EvalMetrics = {
      completionRate: 0.5, passAt1: 0.4, passAt3: 0.6, verifierPassRate: 0.7,
      harnessViolationRate: 0.1, retriesPerTask: 2, humanInterventions: 0,
      recoveryRate: 0.5, costPerSuccess: 0.1, latencyPerSuccess: 1000, contextContinuityRate: 0.9,
    };
    return {
      runId: "r1", modelId: "m1", harnessVersion: "v1",
      capturedAt: "2026-07-11T00:00:00.000Z",
      metrics: { ...base, ...metrics },
    };
  }

  it("completionRate 涨 20% → improvement", () => {
    const { improvement, regression } = diffEvalRuns(
      snapOf({ completionRate: 0.5 }),
      snapOf({ completionRate: 0.7 }),
    );
    expect(improvement.some((d) => d.metric === "completionRate")).toBe(true);
    expect(regression.length).toBe(0);
  });

  it("harnessViolationRate 降 5% → improvement（越低越好）", () => {
    const { improvement } = diffEvalRuns(
      snapOf({ harnessViolationRate: 0.10 }),
      snapOf({ harnessViolationRate: 0.05 }),
    );
    expect(improvement.some((d) => d.metric === "harnessViolationRate")).toBe(true);
  });

  it("涨跌幅 < 5% → significant=false → 不算 regression", () => {
    const { regression } = diffEvalRuns(
      snapOf({ completionRate: 0.50 }),
      snapOf({ completionRate: 0.51 }),  // 涨 2% < 5%
    );
    expect(regression.length).toBe(0);
  });
});