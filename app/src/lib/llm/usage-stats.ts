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
  /** 价格表未命中的调用数；cost 不含这些调用的真实费用 */
  unknownPricingCalls: number;
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
      modelId: mid, cost: 0, calls: 0, unknownPricingCalls: 0, inputTokens: 0, outputTokens: 0,
    };
    mc.cost += r.cost;
    mc.calls += 1;
    if (r.pricingKnown === false) mc.unknownPricingCalls += 1;
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

// ============ 阶段 F1：按 actor 维度（role_kind）聚合 ============
//
// 与 aggregateUsage 不同：
//  - aggregateUsage 按 model 聚合（v0.9 已存在，给 StatsPage "按模型"视图）
//  - aggregateUsageByActorRole 按 actor_kind × model 聚合（F1 新增，给 StatsPage "按角色"视图）
//
// 设计要点（采纳 senior review）：
//  - **NULL roleKind 不过滤**（review F1-1）：leader 是常态、占比 80%+，过滤等于剔主成本
//  - NULL roleKind 当独立"未分类"组显示（用户能看到"主对话"或"未知"占多少）
//  - 排序：roleKind 间按字母序（含 NULL 排最后，可预测）；roleKind 内按 cost 降序
//  - modelId NULL → "(unknown model)"（CLI 引擎某些场景可能没 modelId）
//  - 纯 IO 函数；SQLite 直查；单测覆盖（db.integration.test.ts）

export interface ActorRoleModelUsage {
  /** 阶段 F1：actor 维度（leader/architect/frontend/.../stage/null） */
  roleKind: string | null;
  modelId: string;
  modelName: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** 价格表未命中的调用数；cost 不含这些调用的真实费用 */
  unknownPricingCalls: number;
}

export interface ActorRoleUsage {
  /** NULL = "未分类"组（旧数据 / 非 chain/leader/stage 来源） */
  roleKind: string | null;
  /** 该 roleKind 下所有 model 聚合后的总成本（review F1-9：排序用） */
  totalCost: number;
  /** 该 roleKind 下所有 model 的总调用次数 */
  totalCalls: number;
  rows: ActorRoleModelUsage[];
}

export async function aggregateUsageByActorRole(args: {
  projectId?: string | null;
  since?: string;       // ISO 时间戳
}): Promise<ActorRoleUsage[]> {
  // 阶段 F1：动态 import 避免循环依赖（usage-stats → db）
  const { getDb } = await import("../db");
  const db = await getDb();

  // 动态拼 WHERE：SQLite 占位符 ($1, $2, ...) 顺序对应 params 数组
  const where: string[] = [];
  const params: unknown[] = [];
  if (args.projectId) {
    where.push(`project_id = $${where.length + 1}`);
    params.push(args.projectId);
  }
  if (args.since) {
    where.push(`created_at >= $${where.length + 1}`);
    params.push(args.since);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  // GROUP BY role_kind, model_id；roleKind NULL 排在最前（leader 优先级高，UI 用 IS NULL 排序后再按字母）
  // 注：usage_events 表没有 model_name 列（model_id 本身是可读字符串："claude-opus-4-8" 等），用 modelId 当 displayName
  const rows = await db.select<Array<{
    role_kind: string | null;
    model_id: string | null;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cost: number;
    unknown_pricing_calls: number;
  }>>(
    `SELECT role_kind, model_id,
            COUNT(*) AS calls,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cost) AS cost,
            SUM(CASE WHEN pricing_known = 0 THEN 1 ELSE 0 END) AS unknown_pricing_calls
     FROM usage_events
     ${whereClause}
     GROUP BY role_kind, model_id
     ORDER BY role_kind IS NULL DESC, role_kind ASC, cost DESC`,
    params,
  );

  return doAggregateRoleGroups(
    rows.map((r) => ({
      role_kind: r.role_kind,
      model_id: r.model_id,
      // SQL GROUP BY 后 calls = COUNT(*)，直接传（doAggregateRoleGroups 不重算）
      calls: r.calls,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cost: r.cost,
      unknown_pricing_calls: r.unknown_pricing_calls,
    })),
  );
}

/**
 * 阶段 F2：纯函数版（从内存 rows 聚合，StatsPage 用，**零额外 SQL**）
 *  - 与 async 版共享同一种排序 / 聚合逻辑（共用下面的 doAggregateRoleGroups）
 *  - 输入：useEffect 里已经拿到的 usageEvents.list() 的 rows（避免 F2 计划里 H1 提的"双 effect 链两次 SQL"）
 *  - 输出：ActorRoleUsage[] 形状与 async 版完全一致
 */
export function aggregateUsageByActorRoleFromRows(rows: UsageEventRow[]): ActorRoleUsage[] {
  // 纯函数版：rows 是原始 UsageEvent（每行 1 次调用）→ 传给 doAggregateRoleGroups，calls=1
  return doAggregateRoleGroups(
    rows.map((r) => ({
      role_kind: r.roleKind,
      model_id: r.modelId,
      calls: 1,         // 原始事件：每行 1 次（与 async 路径 SQL GROUP BY COUNT(*) 的语义对齐）
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cost: r.cost,
      unknown_pricing_calls: r.pricingKnown === false ? 1 : 0,
    })),
  );
}

/**
 * 阶段 F2 helper：SQL GROUP BY 后的行 OR 内存原始 events → 聚合 + 排序
 *  - 抽出来给 aggregateUsageByActorRole（async）+ aggregateUsageByActorRoleFromRows（同步）共用
 *  - 避免逻辑漂移
 */
function doAggregateRoleGroups(
  rows: Array<{
    role_kind: string | null;
    model_id: string | null;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cost: number;
    unknown_pricing_calls?: number;
  }>,
): ActorRoleUsage[] {
  // 阶段 I 修：先按 (roleKind, modelId) 合并到 row map，再按 roleKind 分组
  // 原因：纯函数版输入是原始 rows（每行 calls=1），与 async 版的 SQL GROUP BY 行（每行 calls=N）语义不同
  // async 路径：SQL 已经 GROUP BY，每行是聚合后的（roleKind, modelId, calls=N, cost=sum）
  // 纯函数路径：每行 1 次，需要在内存里再做一次合并
  // 不分两步会重复 push：3 行同 (roleKind, modelId) 会变 3 个 row 而不是 1 个 row
  const rowKey = (r: { role_kind: string | null; model_id: string | null }) => {
    const rk = r.role_kind ?? null;
    const mid = r.model_id ?? "(unknown model)";
    return `${rk ?? "null"}|${mid}`;
  };
  const rowMap = new Map<string, ActorRoleModelUsage>();
  for (const r of rows) {
    const k = rowKey(r);
    const existing = rowMap.get(k);
    if (existing) {
      existing.calls += r.calls;
      existing.inputTokens += r.input_tokens;
      existing.outputTokens += r.output_tokens;
      existing.cost += r.cost;
      existing.unknownPricingCalls += r.unknown_pricing_calls ?? 0;
    } else {
      const roleKind: string | null = r.role_kind ?? null;
      const modelId = r.model_id ?? "(unknown model)";
      rowMap.set(k, {
        roleKind,
        modelId,
        modelName: modelId,
        calls: r.calls,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cost: r.cost,
        unknownPricingCalls: r.unknown_pricing_calls ?? 0,
      });
    }
  }

  // 按 roleKind 分组
  const map = new Map<string | null, ActorRoleModelUsage[]>();
  for (const row of rowMap.values()) {
    const list = map.get(row.roleKind) ?? [];
    list.push(row);
    map.set(row.roleKind, list);
  }

  // 转成数组 + 二次排序（NULL 最后，按字母序；同 roleKind 内按 totalCost 降序）
  const result: ActorRoleUsage[] = [];
  for (const [roleKind, modelRows] of map) {
    const totalCost = modelRows.reduce((s, r) => s + r.cost, 0);
    const totalCalls = modelRows.reduce((s, r) => s + r.calls, 0);
    // modelRows 已在 SQL 层按 cost DESC 排序；这里再排一次确保
    const sortedRows = [...modelRows].sort((a, b) => b.cost - a.cost);
    result.push({ roleKind, totalCost, totalCalls, rows: sortedRows });
  }
  result.sort((a, b) => {
    // NULL roleKind 排最后（review F1-1 强调：NULL 是真实数据但通常代表未分类，UI 放最后）
    if (a.roleKind === null && b.roleKind !== null) return 1;
    if (a.roleKind !== null && b.roleKind === null) return -1;
    if (a.roleKind === null && b.roleKind === null) return 0;
    return (a.roleKind as string).localeCompare(b.roleKind as string);
  });
  return result;
}
