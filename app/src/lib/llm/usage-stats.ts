// v0.9 阶段7 — 用量统计聚合（StatsPage 数据源）
//
// 纯函数：把 UsageEvent 行聚合成 StatsPage 需要的视图（总成本 / 近 7 天趋势 / 按模型）。
// 与 db 解耦，便于单测。

import type { UsageEventRow } from "../db";

export interface DayCost {
  /** YYYY-MM-DD（本地时区） */
  date: string;
  cost: number;
  tokens: number;
}

export interface ModelCost {
  modelId: string;
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageSummary {
  todayCost: number;
  last7dCost: number;
  last30dCost: number;
  totalCalls: number;
  byDay: DayCost[]; // 最近 7 天，含 0 成本日，按日期升序
  byModel: ModelCost[]; // 按成本降序
}

/** 本地日期 key YYYY-MM-DD */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 聚合用量。now 注入便于测试。
 */
export function aggregateUsage(rows: UsageEventRow[], now: Date = new Date()): UsageSummary {
  const todayKey = dayKey(now);
  const ms30 = 30 * 86_400_000;
  const nowMs = now.getTime();

  let last30dCost = 0;
  const byModelMap = new Map<string, ModelCost>();
  const byDayMap = new Map<string, DayCost>();

  // 预置最近 7 天（含 0 成本日）
  for (let i = 6; i >= 0; i--) {
    const d = new Date(nowMs - i * 86_400_000);
    byDayMap.set(dayKey(d), { date: dayKey(d), cost: 0, tokens: 0 });
  }

  for (const r of rows) {
    const t = new Date(r.createdAt).getTime();
    if (Number.isNaN(t)) continue;
    if (nowMs - t <= ms30) last30dCost += r.cost;

    const dk = dayKey(new Date(t));
    const day = byDayMap.get(dk);
    if (day) {
      day.cost += r.cost;
      day.tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    }

    const mid = r.modelId ?? "(unknown)";
    const mc = byModelMap.get(mid) ?? {
      modelId: mid, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0,
    };
    mc.cost += r.cost;
    mc.calls += 1;
    mc.inputTokens += r.inputTokens || 0;
    mc.outputTokens += r.outputTokens || 0;
    byModelMap.set(mid, mc);
  }

  // today/7d 直接从 byDay 派生（最近 7 天那几格已含同样数据），不重复累加
  const byDay = Array.from(byDayMap.values());
  return {
    todayCost: byDayMap.get(todayKey)?.cost ?? 0,
    last7dCost: byDay.reduce((s, d) => s + d.cost, 0),
    last30dCost,
    totalCalls: rows.length,
    byDay,
    byModel: Array.from(byModelMap.values()).sort((a, b) => b.cost - a.cost),
  };
}
