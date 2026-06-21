// v0.9 阶段7 — 模型表现滚动统计（SmartRouter 评分的数据源）
//
// 病根：v1 规则路由只按"模型名→档位"静态判断，不知道某个模型在某类任务上实际表现如何
// （成功率高不高、贵不贵、慢不慢）。SmartRouter 要按真实历史评分，就需要这张滚动统计。
//
// 设计（按 v2 方案"增量更新，不做定时任务"）：每写一条 UsageEvent，就按 (modelId, taskType)
// 增量更新一条统计。taskType = 消息难度桶（simple/standard/hard，来自 classifyMessageComplexity）。
// 用累积式增量均值（不做 7 天滑窗淘汰）——自用阶段够用；真正的滑窗重算推到 v0.9.1。

import { modelPerformanceStats } from "../db";

/** 评分启用门槛：样本不足时 SmartRouter 不信这个统计，回落 v1 规则路由 */
export const MIN_SAMPLES_FOR_SCORING = 30;

/** 一次调用的表现样本 */
export interface PerfSample {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs?: number;
  success: boolean;
}

/** 一条滚动统计（对应 model_performance_stats 表一行） */
export interface ModelPerfStat {
  modelId: string;
  taskType: string;
  successRate: number; // 0-1
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCost: number;
  avgLatencyMs: number;
  sampleCount: number;
  windowStart: string;
  windowEnd: string;
}

/** 增量均值：avg_new = avg_old + (x - avg_old) / (n + 1) */
function incMean(avgOld: number, x: number, nOld: number): number {
  return avgOld + (x - avgOld) / (nOld + 1);
}

/**
 * 纯函数：把一个新样本并入已有统计，返回新统计。
 * prev=null 表示该 (modelId, taskType) 首次出现。
 * 不读不写 db，便于单测增量均值数学。
 */
export function mergeSample(
  prev: ModelPerfStat | null,
  sample: PerfSample,
  modelId: string,
  taskType: string,
  ts: string,
): ModelPerfStat {
  const successVal = sample.success ? 1 : 0;
  const latency = sample.latencyMs ?? 0;

  if (!prev) {
    return {
      modelId,
      taskType,
      successRate: successVal,
      avgInputTokens: sample.inputTokens,
      avgOutputTokens: sample.outputTokens,
      avgCost: sample.cost,
      avgLatencyMs: latency,
      sampleCount: 1,
      windowStart: ts,
      windowEnd: ts,
    };
  }

  const n = prev.sampleCount;
  return {
    modelId: prev.modelId,
    taskType: prev.taskType,
    successRate: incMean(prev.successRate, successVal, n),
    avgInputTokens: incMean(prev.avgInputTokens, sample.inputTokens, n),
    avgOutputTokens: incMean(prev.avgOutputTokens, sample.outputTokens, n),
    avgCost: incMean(prev.avgCost, sample.cost, n),
    avgLatencyMs: incMean(prev.avgLatencyMs, latency, n),
    sampleCount: n + 1,
    windowStart: prev.windowStart,
    windowEnd: ts,
  };
}

/** 样本是否够多到可以用于评分 */
export function isScoreEligible(stat: ModelPerfStat | null | undefined): boolean {
  return !!stat && stat.sampleCount >= MIN_SAMPLES_FOR_SCORING;
}

/**
 * 写入一个表现样本：读现有统计 → 合并 → upsert。
 * 失败只记日志不抛（统计是旁路，不能拖垮主对话流）。
 */
export async function recordPerformanceSample(
  modelId: string,
  taskType: string,
  sample: PerfSample,
): Promise<void> {
  try {
    const prev = await modelPerformanceStats.get(modelId, taskType);
    const next = mergeSample(prev, sample, modelId, taskType, new Date().toISOString());
    await modelPerformanceStats.upsert(next);
  } catch (error) {
    console.error("[model-performance-stats] 写入统计失败:", error);
  }
}
