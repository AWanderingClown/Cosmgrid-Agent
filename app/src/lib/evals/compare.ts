// Harness 工程实施计划 阶段4 — 两次 eval run diff。
//
// `diffEvalRuns(baseline, candidate)`：对比 11 个指标，标 regression / improvement / overall。
// 噪声阈值：metric 涨跌幅 < 5% 视为"不显著"，不报警。

import type { EvalMetrics } from "./types";
export type EvalRunSnapshot = {
  runId: string;
  modelId: string;
  harnessVersion: string;
  capturedAt: string;
  metrics: EvalMetrics;
};


export interface MetricDelta {
  metric: keyof EvalMetrics;
  baseline: number;
  candidate: number;
  abs: number;       // candidate - baseline
  rel: number;       // (candidate - baseline) / max(|baseline|, 0.001)
  significant: boolean; // rel 绝对值 >= noiseThreshold
}

/** 哪些 metric 涨算 improvement（越高越好），哪些是反过来 */
const HIGHER_IS_BETTER: Record<keyof EvalMetrics, boolean> = {
  completionRate: true,
  passAt1: true,
  passAt3: true,
  verifierPassRate: true,
  recoveryRate: true,
  contextContinuityRate: true,
  harnessViolationRate: false,  // 越低越好（违规率）
  retriesPerTask: false,        // 越低越好
  humanInterventions: false,   // 越低越好
  costPerSuccess: false,        // 越低越好
  latencyPerSuccess: false,     // 越低越好
};

const NOISE_THRESHOLD = 0.05;  // 5% 涨跌幅以下视为不显著

export function diffEvalRuns(
  baseline: EvalRunSnapshot,
  candidate: EvalRunSnapshot,
  options: { noiseThreshold?: number } = {},
): { overall: MetricDelta[]; regression: MetricDelta[]; improvement: MetricDelta[] } {
  const threshold = options.noiseThreshold ?? NOISE_THRESHOLD;
  const overall: MetricDelta[] = [];
  for (const m of Object.keys(baseline.metrics) as Array<keyof EvalMetrics>) {
    const b = baseline.metrics[m];
    const c = candidate.metrics[m];
    const abs = c - b;
    const rel = abs / Math.max(Math.abs(b), 0.001);
    const significant = Math.abs(rel) >= threshold;
    overall.push({ metric: m, baseline: b, candidate: c, abs, rel, significant });
  }

  // 分类：better / worse / neutral
  const improvement: MetricDelta[] = [];
  const regression: MetricDelta[] = [];
  for (const d of overall) {
    if (!d.significant) continue;
    const higherBetter = HIGHER_IS_BETTER[d.metric];
    const isBetter = higherBetter ? d.abs > 0 : d.abs < 0;
    if (isBetter) improvement.push(d);
    else regression.push(d);
  }

  return { overall, regression, improvement };
}