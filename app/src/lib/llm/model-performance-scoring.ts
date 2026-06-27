// 阶段3c — 让编排器接 SmartRouter 真表现评分，替掉 model-capabilities 的静态名字查表分。
//
// 现状：SmartRouter（smart-router.ts scoreCandidates）已经按真表现（成功率贝叶斯收缩 +
// 成本/延迟）给候选模型打分，但 orchestrator 的 resolveOrchestration 用的是
// pickBestModelForRole（静态 capability_score，M3 因名字不带标记判 unknown 给 72）。
// 本文件：纯函数核心——有真表现分时按真表现排序，否则 fallback 静态分。
//
// 集成 TODO：ChatPage 在 resolveOrchestration 前预取 scoreCandidates 结果，
// 转成 PerformanceScores Map 传入 resolveOrchestration（要改其签名加可选参数 + 预取 async）。
// 这步是 async/sync 架构改动 + 要 UI 验证，留后续。

import { scoreModelForRole, type ScorableModel } from "./model-capabilities";
import { scoreByUserBaseline } from "./user-tier-baseline";

/** 真表现分（0-100，来自 SmartRouter scoreCandidates 预取，ChatPage 转成 Map 传入） */
export type PerformanceScores = Map<string, number>;

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

