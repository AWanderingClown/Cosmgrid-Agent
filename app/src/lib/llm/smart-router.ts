// v0.9 阶段7 — SmartRouter（v2 智能路由，叠加在 v1 规则路由之上）
//
// v1（message-router.ts）只按"模型名→档位"静态选模型。v2 在有足够历史样本时，按真实表现
// （成功率 / 成本 / 延迟）评分选模型，并在配额将尽时自动降级。样本不足 / 出错 → 回落 v1。
//
// 决策可解释：每次返回 DecisionLog，UI 能展示"为什么选这个模型"。

import { classifyMessageComplexity, pickModelForMessage, type RoutableModel } from "./message-router";
import {
  modelPerformanceStats,
  type ModelPerformanceStatRow,
} from "../db";
import { isScoreEligible, shrinkSuccessRate } from "./model-performance-stats";

/** 配额将尽阈值：剩余 < 此比例时优先降级 */
export const QUOTA_LOW_RATIO = 0.1;

/** 评分权重：阶段6 后分开看任务质量、验证通过、成功成本和延迟。 */
const W_TASK_SUCCESS = 0.35;
const W_VERIFIER = 0.25;
const W_COST_PER_SUCCESS = 0.3;
const W_LATENCY = 0.1;

export interface RouterContext {
  /** 任务桶；不传则用 classifyMessageComplexity 推断 */
  taskType?: string;
  /** 各模型剩余配额比例 0-1（1=充足，0=耗尽）；不传视为充足 */
  quotaByModelId?: Record<string, number>;
}

export interface ScoredCandidate {
  modelId: string;
  score: number;
  successRate: number;
  taskSuccessRate: number;
  verifierPassRate: number;
  avgCost: number;
  costPerSuccess: number;
  avgLatencyMs: number;
}

export type RouteStrategy = "scored" | "scored-quota-downgrade" | "v1-fallback";

export interface DecisionLog {
  chosenModelId: string;
  taskType: string;
  strategy: RouteStrategy;
  reasons: string[];
  scores: ScoredCandidate[];
}

export interface RouteResult<T> {
  model: T;
  decisionLog: DecisionLog;
}

/**
 * 纯函数：给一组「带统计的候选」打分排序（分越高越好）。
 * 成本/延迟在候选内归一化（除以最大值），缺统计的候选已在调用方过滤。
 */
export function scoreCandidates(
  items: Array<{ modelId: string; stat: ModelPerformanceStatRow }>,
): ScoredCandidate[] {
  if (items.length === 0) return [];
  const maxCostPerSuccess = Math.max(
    ...items.map((i) => i.stat.costPerSuccess > 0 ? i.stat.costPerSuccess : i.stat.avgCost),
    1e-9,
  );
  const maxLatency = Math.max(...items.map((i) => i.stat.avgLatencyMs), 1e-9);

  return items
    .map(({ modelId, stat }) => {
      const rawTaskSuccess = stat.taskSuccessRate || stat.successRate;
      const rawVerifierPass = stat.verifierPassRate || stat.successRate;
      const costPerSuccess = stat.costPerSuccess > 0 ? stat.costPerSuccess : stat.avgCost;
      const normCostPerSuccess = costPerSuccess / maxCostPerSuccess;
      const normLatency = stat.avgLatencyMs / maxLatency;
      // 任务成功和验证通过分别收缩，避免把“正常输出但任务没完成”算成高成功率。
      const shrunkTaskSuccess = shrinkSuccessRate(rawTaskSuccess, stat.sampleCount);
      const shrunkVerifierPass = shrinkSuccessRate(rawVerifierPass, stat.sampleCount);
      const score =
        W_TASK_SUCCESS * shrunkTaskSuccess +
        W_VERIFIER * shrunkVerifierPass +
        W_COST_PER_SUCCESS * (1 - normCostPerSuccess) +
        W_LATENCY * (1 - normLatency);
      return {
        modelId,
        score,
        successRate: shrunkTaskSuccess,
        taskSuccessRate: shrunkTaskSuccess,
        verifierPassRate: shrunkVerifierPass,
        avgCost: stat.avgCost,
        costPerSuccess,
        avgLatencyMs: stat.avgLatencyMs,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function quotaOf(ctx: RouterContext, modelId: string): number {
  return ctx.quotaByModelId?.[modelId] ?? 1;
}

/**
 * SmartRouter 主入口：给一条消息和候选模型，按真实表现评分选模型。
 * - 够样本的候选 ≥ 1 个 → 评分路由（含配额降级）
 * - 否则 → 回落 v1 pickModelForMessage
 * - models 为空 → null
 */
export async function routeMessage<T extends RoutableModel & { id?: string }>(
  text: string,
  models: T[],
  ctx: RouterContext = {},
): Promise<RouteResult<T> | null> {
  if (models.length === 0) return null;

  const taskType = ctx.taskType ?? classifyMessageComplexity(text);
  const modelIdOf = (m: T) => m.id ?? m.name;

  // 一次性拉全部统计（避免逐模型串行 DB round-trip），按 (modelId, taskType) 建索引
  const allStats = await modelPerformanceStats.list();
  const statByKey = new Map(allStats.map((s) => [`${s.modelId} ${s.taskType}`, s]));

  // 收集够样本的候选
  const withStats: Array<{ modelId: string; model: T; stat: ModelPerformanceStatRow }> = [];
  for (const m of models) {
    const stat = statByKey.get(`${modelIdOf(m)} ${taskType}`);
    if (isScoreEligible(stat)) withStats.push({ modelId: modelIdOf(m), model: m, stat: stat! });
  }

  // 样本不足 → v1 规则路由
  if (withStats.length === 0) {
    return v1Fallback(text, models, taskType, ["候选模型在该任务类型上均无历史样本（首次使用），按 v1 规则路由，本次结果将成为后续评分的数据"]);
  }

  // 评分排序
  const scores = scoreCandidates(withStats);
  const modelByScoreId = new Map(withStats.map((w) => [w.modelId, w.model]));

  // 配额：过滤掉耗尽（=0）的；剩余 < QUOTA_LOW_RATIO 的排到后面
  const usable = scores.filter((s) => quotaOf(ctx, s.modelId) > 0);
  if (usable.length === 0) {
    return v1Fallback(text, models, taskType, ["候选模型配额全部耗尽，按 v1 规则路由"]);
  }

  const top = usable[0]!;
  const topQuota = quotaOf(ctx, top.modelId);

  // top 配额将尽且有次优 → 降级
  if (topQuota < QUOTA_LOW_RATIO && usable.length > 1) {
    const next = usable[1]!;
    return {
      model: modelByScoreId.get(next.modelId)!,
      decisionLog: {
        chosenModelId: next.modelId,
        taskType,
        strategy: "scored-quota-downgrade",
        reasons: [
          `首选 ${top.modelId} 配额仅剩 ${(topQuota * 100).toFixed(0)}%，降级到次优 ${next.modelId}`,
          `按成功率/成本/延迟评分（次优分 ${next.score.toFixed(3)}）`,
        ],
        scores,
      },
    };
  }

  return {
    model: modelByScoreId.get(top.modelId)!,
    decisionLog: {
      chosenModelId: top.modelId,
      taskType,
      strategy: "scored",
      reasons: [
        `按真实表现评分最高（${top.score.toFixed(3)}）`,
        `任务成功率 ${(top.taskSuccessRate * 100).toFixed(0)}% · 验证通过率 ${(top.verifierPassRate * 100).toFixed(0)}% · 成功成本 $${top.costPerSuccess.toFixed(4)} · 延迟 ${Math.round(top.avgLatencyMs)}ms`,
      ],
      scores,
    },
  };
}

function v1Fallback<T extends RoutableModel & { id?: string }>(
  text: string,
  models: T[],
  taskType: string,
  reasons: string[],
): RouteResult<T> | null {
  const picked = pickModelForMessage(text, models, "main_chat");
  if (!picked) return null;
  const modelIdOf = (m: T) => m.id ?? m.name;
  return {
    model: picked.model,
    decisionLog: {
      chosenModelId: modelIdOf(picked.model),
      taskType,
      strategy: "v1-fallback",
      reasons,
      scores: [],
    },
  };
}
