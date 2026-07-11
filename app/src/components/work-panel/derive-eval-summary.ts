// Harness 工程实施计划 阶段4 — Eval Summary 派生函数（纯函数）。
//
// 把 eval_runs + eval_results + task_outcomes 聚合成一个 EvalSummaryView，UI 直接消费。
// 不允许 IO（输入由 caller 喂，测试易写）。

import type { EvalRunRow, EvalResultRow, TaskOutcomeRow } from "@/lib/db";
import type { EvalMetrics } from "@/lib/evals/types";
import { aggregateEvalMetrics } from "@/lib/evals/metrics";

export interface EvalSummaryView {
  status: "absent" | "ready" | "running";
  latestRunId: string | null;
  latestHarnessVersion: string | null;
  totalCases: number;
  passedCases: number;
  totalCostUsd: number;
  /** 11 指标快照 */
  metrics: EvalMetrics;
  /** cost_per_success vs 上次 run 涨跌幅（>0.3 触发红色告警） */
  costSpikeAlert: boolean;
  /** 失败类型直方图（top 5） */
  failureKinds: Array<{ kind: string; count: number }>;
}

const COST_SPIKE_THRESHOLD = 0.3;  // 30%

export function deriveEvalSummary(args: {
  runs: EvalRunRow[];
  results: EvalResultRow[];
  taskOutcomes?: TaskOutcomeRow[];
  /** 上一轮 run 的 costPerSuccess（用于 cost spike 告警） */
  prevCostPerSuccess?: number;
}): EvalSummaryView {
  if (args.runs.length === 0) {
    return emptySummary();
  }
  const latest = args.runs[0]!;
  const latestResults = args.results.filter((r) => r.runId === latest.id);

  // results 全部 attempt 转 EvalResult 形态喂给 aggregateEvalMetrics
  const evalResults = latestResults.map((r) => ({
    id: r.id, runId: r.runId, taskId: r.taskId, attemptIndex: r.attemptIndex,
    passed: r.passed, attemptCostUsd: r.attemptCostUsd, attemptLatencyMs: r.attemptLatencyMs,
    interventionsCount: r.interventionsCount, failureCode: r.failureCode ?? undefined,
    gradedJson: r.gradedJson ?? undefined,
  }));
  const metrics = aggregateEvalMetrics(evalResults);

  const passedCases = new Set(latestResults.filter((r) => r.passed).map((r) => r.taskId)).size;
  const totalCases = new Set(latestResults.map((r) => r.taskId)).size;

  // cost spike 告警
  const costSpikeAlert = args.prevCostPerSuccess !== undefined
    && metrics.costPerSuccess > args.prevCostPerSuccess * (1 + COST_SPIKE_THRESHOLD);

  // 失败类型直方图（top 5）
  const kindMap = new Map<string, number>();
  for (const r of latestResults) {
    if (r.failureCode) kindMap.set(r.failureCode, (kindMap.get(r.failureCode) ?? 0) + 1);
  }
  const failureKinds = [...kindMap.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    status: latest.status === "running" ? "running" : "ready",
    latestRunId: latest.id,
    latestHarnessVersion: latest.harnessVersion,
    totalCases,
    passedCases,
    totalCostUsd: latest.totalCostUsd,
    metrics,
    costSpikeAlert,
    failureKinds,
  };
}

function emptySummary(): EvalSummaryView {
  return {
    status: "absent",
    latestRunId: null,
    latestHarnessVersion: null,
    totalCases: 0,
    passedCases: 0,
    totalCostUsd: 0,
    metrics: {
      completionRate: 0, passAt1: 0, passAt3: 0, verifierPassRate: 0,
      harnessViolationRate: 0, retriesPerTask: 0, humanInterventions: 0,
      recoveryRate: 1, costPerSuccess: 0, latencyPerSuccess: 0, contextContinuityRate: 1,
    },
    costSpikeAlert: false,
    failureKinds: [],
  };
}