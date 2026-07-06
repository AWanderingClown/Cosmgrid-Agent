// 阶段3c — 让编排器接 SmartRouter 真表现评分，替掉 model-capabilities 的静态名字查表分。
//
// 现状：SmartRouter（smart-router.ts scoreCandidates）已经按真表现（成功率贝叶斯收缩 +
// 成本/延迟）给候选模型打分，但 orchestrator 的 resolveOrchestration 用的是
// pickBestModelForRole（静态 capability_score，M3 因名字不带标记判 unknown 给 72）。
// 本文件：纯函数核心。
// - 单轮主聊天：有真表现分时按真表现排序，否则 fallback 静态分。
// - 多角色协作链：按 roleKind 聚合真实表现，只做小幅加成，避免把闲聊表现误用到前端/测试/安全等角色。

import { scoreModelForRole, type ScorableModel } from "./model-capabilities";
import { scoreByUserBaseline } from "./user-tier-baseline";
import type { UsageEventRow } from "../db";

/** 真表现分（0-100，来自 SmartRouter scoreCandidates 预取，ChatPage 转成 Map 传入） */
export type PerformanceScores = Map<string, number>;
export type RolePerformanceScores = Map<string, PerformanceScores>;

const ROLE_PERFORMANCE_MAX_BONUS = 6;

export function buildRolePerformanceScoresFromUsageRows(rows: UsageEventRow[]): RolePerformanceScores {
  const grouped = new Map<string, Map<string, {
    count: number;
    success: number;
    knownCostCount: number;
    totalKnownCost: number;
  }>>();
  for (const row of rows) {
    if (!row.roleKind || !row.modelId) continue;
    const byModel = grouped.get(row.roleKind) ?? new Map<string, {
      count: number;
      success: number;
      knownCostCount: number;
      totalKnownCost: number;
    }>();
    const stat = byModel.get(row.modelId) ?? { count: 0, success: 0, knownCostCount: 0, totalKnownCost: 0 };
    stat.count += 1;
    stat.success += row.success ? 1 : 0;
    if (row.pricingKnown) {
      stat.knownCostCount += 1;
      stat.totalKnownCost += row.cost;
    }
    byModel.set(row.modelId, stat);
    grouped.set(row.roleKind, byModel);
  }

  const out: RolePerformanceScores = new Map();
  for (const [role, byModel] of grouped) {
    const stats = Array.from(byModel.entries()).map(([modelId, stat]) => ({
      modelId,
      successRate: stat.success / Math.max(stat.count, 1),
      avgCost: stat.knownCostCount > 0 ? stat.totalKnownCost / stat.knownCostCount : null,
    }));
    const knownCosts = stats.flatMap((s) => s.avgCost === null ? [] : [s.avgCost]);
    const maxCost = Math.max(...knownCosts, 1e-9);
    const scores: PerformanceScores = new Map();
    for (const stat of stats) {
      const costEfficiency = stat.avgCost === null ? 0.5 : 1 - stat.avgCost / maxCost;
      scores.set(stat.modelId, Math.round((stat.successRate * 0.75 + costEfficiency * 0.25) * 100));
    }
    out.set(role, scores);
  }
  return out;
}

/**
 * 给定角色选最合适模型。三层优先级（高→低）：
 * 1. 真表现分（model_performance_stats 实测，跑多了才有）
 * 2. 用户主观基线（user-tier-baseline，用户拍脑袋但实际用过，冷启动兜底）
 * 3. 名字查表静态分（detectModelTier，最不准，最后兜底）
 *
 * 真表现覆盖一切；没真表现时用户基线覆盖名字查表（用户基线比名字查表准）。
 */
export function pickBestModelWithPerformance<T extends ScorableModel>(
  role: string,
  models: T[],
  performanceScores?: PerformanceScores,
): T | null {
  if (models.length === 0) return null;
  const scored = models.map((m) => {
    const perf = performanceScores?.get(m.id);
    const baseline = scoreByUserBaseline(m.name, role);
    const stat = scoreModelForRole(m, role);
    const score = perf ?? baseline ?? stat; // 三层优先级
    return { m, score };
  });
  return scored.sort((a, b) => b.score - a.score)[0]?.m ?? null;
}

/**
 * 角色级真实表现只做有限加成，不覆盖基础角色能力。
 * 这样 "leader/main_chat 表现好" 不会误伤 frontend/tester/security 等角色分配。
 */
export function pickBestModelWithRolePerformance<T extends ScorableModel>(
  workRole: string,
  actorRole: string,
  models: T[],
  rolePerformanceScores?: RolePerformanceScores,
): T | null {
  if (models.length === 0) return null;
  const scores = rolePerformanceScores?.get(actorRole);
  const scored = models.map((m) => {
    const baseline = scoreByUserBaseline(m.name, workRole);
    const staticScore = scoreModelForRole(m, workRole);
    const base = baseline ?? staticScore;
    const perf = scores?.get(m.id);
    const bonus = perf === undefined
      ? 0
      : ((perf - 50) / 50) * ROLE_PERFORMANCE_MAX_BONUS;
    return { m, score: base + bonus, base, perf: perf ?? null };
  });
  return scored.sort((a, b) => b.score - a.score || b.base - a.base)[0]?.m ?? null;
}
