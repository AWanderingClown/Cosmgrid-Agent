// StatsPage - v0.9 阶段7：用量与省钱统计（成本趋势 / 按模型 / 缓存 / 模型表现）
// 阶段 F2：在 byModel 卡片内加 drill-down 展开"按角色 × 模型"拆分（采纳 frontend-ui-expert review）
//  - byModel 是主页（不动），点 modelId 行 → 展开该 model 的角色拆分
//  - 角色卡片用 ROLE_COLOR_MAP 配色（orchestrator.ts 单一来源；本文件 0 处复用——ChainProgressBar 后续迭代时考虑统一）
//  - 角色排序：totalCost DESC（贵的在前；review M2）
//  - 零额外 SQL：复用 useEffect 已拿到的 rows，调 aggregateUsageByActorRoleFromRows（review H1）
//  - 测试覆盖：阶段 I 补 aggregateUsageByActorRoleFromRows 单测 8 个（铁律 1 修）；StatsPage 组件测试项目无 jsdom 跳过
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart3, Coins, Sparkles, Activity, Cpu, Wrench, FileEdit, Terminal, Eye,
  ChevronRight, ChevronDown,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  usageEvents, semanticCache, modelPerformanceStats, toolExecutions,
  type ModelPerformanceStatRow, type ToolExecutionRow, type UsageEventRow,
} from "@/lib/db";
import {
  aggregateUsage,
  aggregateUsageByActorRoleFromRows,
  type UsageSummary,
  type ActorRoleUsage,
  type ActorRoleModelUsage,
} from "@/lib/llm/usage-stats";
import { cleanupExpiredCache } from "@/lib/llm/semantic-cache";
import { formatCost as fmtCost } from "@/lib/utils";
import {
  ROLE_IDS, ROLE_COLOR, STAGE_COLOR, UNKNOWN_COLOR,
  type RoleId,
} from "@/lib/llm/orchestrator";

export function StatsPage() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [cache, setCache] = useState<{ entries: number; totalHits: number }>({ entries: 0, totalHits: 0 });
  const [perf, setPerf] = useState<ModelPerformanceStatRow[]>([]);
  const [toolExecs, setToolExecs] = useState<ToolExecutionRow[]>([]);
  const [loading, setLoading] = useState(true);
  // 阶段 F2：byModel 行点击展开角色拆分（drill-down）
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  // 阶段 F2：rows 状态保留（用于派生 byActorRole，不另起 SQL）
  const [rows, setRows] = useState<UsageEventRow[]>([]);

  useEffect(() => {
    (async () => {
      try {
        void cleanupExpiredCache();
        const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const [rowsRes, cacheStats, perfRows, execs] = await Promise.all([
          usageEvents.list(since),
          semanticCache.stats(),
          modelPerformanceStats.list(),
          toolExecutions.list(30),
        ]);
        setSummary(aggregateUsage(rowsRes));
        setRows(rowsRes);  // ★ 保留 rows 给 F2 byActorRole 派生（零额外 SQL）
        setCache(cacheStats);
        setPerf(perfRows);
        setToolExecs(execs);
      } catch (err) {
        // 阶段 I 修（铁律 4：静默吞错）：原 `} catch {` 没打日志，失败用户完全无感
        // 加 console.error 让 dev/QA 能看到；用户也至少在 devtools 看到 [StatsPage] 前缀
        // eslint-disable-next-line no-console
        console.error("[StatsPage] load failed:", err);
        setSummary(aggregateUsage([]));
        setRows([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // 阶段 F2：从同一份 rows 派生 byActorRole（review H1：零额外 SQL）
  // 排序由聚合函数内负责（NULL 最后 + 字母序 + 同 roleKind 内 cost DESC，review F1-9）
  const byActorRole: ActorRoleUsage[] = useMemo(
    () => aggregateUsageByActorRoleFromRows(rows),
    [rows],
  );

  const maxDayCost = Math.max(...(summary?.byDay.map((d) => d.cost) ?? [0]), 0.0001);

  return (
    <div className="h-full w-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="space-y-10 pb-20">
        <header className="space-y-3 border-l-4 border-primary pl-6 py-2">
          <div className="flex items-center gap-2 text-primary font-bold">
            <BarChart3 className="w-5 h-5" />
            <span className="text-xs uppercase tracking-widest">{t("stats.sectionLabel")}</span>
          </div>
          <h1 className="text-4xl font-black tracking-tight dark:text-white">{t("stats.title")}</h1>
          <p className="text-muted-foreground dark:text-muted-foreground/80 text-sm max-w-2xl leading-relaxed">
            {t("stats.desc")}
          </p>
        </header>

        {loading ? (
          <div className="text-sm text-muted-foreground">{t("stats.loading")}</div>
        ) : (
          <div className="space-y-6">
            {/* 概览卡片 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <StatCard icon={<Coins className="w-4 h-4" />} label={t("stats.today")} value={fmtCost(summary!.todayCost)} />
              <StatCard icon={<Activity className="w-4 h-4" />} label={t("stats.last7d")} value={fmtCost(summary!.last7dCost)} />
              <StatCard icon={<Activity className="w-4 h-4" />} label={t("stats.last30d")} value={fmtCost(summary!.last30dCost)} />
              <StatCard icon={<Sparkles className="w-4 h-4 text-emerald-500" />} label={t("stats.cacheHits")} value={String(cache.totalHits)} />
            </div>

            {/* 7 天成本趋势（零依赖 CSS 柱状图） */}
            <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 shadow-xl">
              <div className="flex items-center gap-3 pb-6 border-b border-white/10">
                <BarChart3 className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-bold dark:text-white">{t("stats.trendTitle")}</h2>
              </div>
              <div className="flex items-end justify-between gap-2 h-40 pt-6">
                {summary!.byDay.map((d) => (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-2 group">
                    <div className="text-[9px] font-bold text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                      {fmtCost(d.cost)}
                    </div>
                    <div className="w-full flex items-end justify-center" style={{ height: "100px" }}>
                      <div
                        className="w-full max-w-[28px] rounded-t-lg bg-gradient-to-t from-primary/40 to-primary transition-all duration-500"
                        style={{ height: `${Math.max(3, (d.cost / maxDayCost) * 100)}%` }}
                      />
                    </div>
                    <div className="text-[9px] font-bold text-muted-foreground">{d.date.slice(5)}</div>
                  </div>
                ))}
              </div>
            </Card>

            {/* 阶段 F2：按模型成本（drill-down 展开角色拆分）*/}
            <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 shadow-xl">
              <div className="flex items-center gap-3 pb-6 border-b border-white/10">
                <Cpu className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-bold dark:text-white">{t("stats.byModelTitle")}</h2>
                <span className="text-[9px] text-muted-foreground/60 italic">
                  {t("stats.byModelDrilldownHint")}
                </span>
              </div>
              {summary!.byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground pt-6">{t("stats.noData")}</p>
              ) : (
                <div className="pt-4 space-y-2">
                  {summary!.byModel.slice(0, 10).map((m) => {
                    const isExpanded = expandedModelId === m.modelId;
                    return (
                      <div key={m.modelId} className="rounded-xl overflow-hidden">
                        <button
                          type="button"
                          data-testid={`byModel-row-${m.modelId}`}
                          onClick={() => setExpandedModelId(isExpanded ? null : m.modelId)}
                          className="w-full flex items-center justify-between gap-4 p-3 bg-white/5 hover:bg-white/10 transition-colors text-sm text-left"
                        >
                          <span className="font-mono text-xs truncate flex-1">{m.modelId}</span>
                          <span className="text-muted-foreground text-xs">{t("stats.calls", { n: m.calls })}</span>
                          <span className="font-bold tabular-nums">{fmtCost(m.cost)}</span>
                          {isExpanded
                            ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                            : <ChevronRight className="w-4 h-4 text-muted-foreground/50 shrink-0" />
                          }
                        </button>
                        {isExpanded && (
                          <ModelRoleBreakdown
                            modelId={m.modelId}
                            allGroups={byActorRole}
                            t={t}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* 模型表现（SmartRouter 评分数据） */}
            <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 shadow-xl">
              <div className="flex items-center gap-3 pb-6 border-b border-white/10">
                <Activity className="w-5 h-5 text-amber-500" />
                <h2 className="text-lg font-bold dark:text-white">{t("stats.perfTitle")}</h2>
              </div>
              {perf.length === 0 ? (
                <p className="text-sm text-muted-foreground pt-6">{t("stats.perfEmpty")}</p>
              ) : (
                <div className="pt-4 space-y-2">
                  {perf.map((p) => (
                    <div key={`${p.modelId}-${p.taskType}`} className="flex items-center justify-between gap-3 p-3 bg-white/5 rounded-xl text-xs">
                      <span className="font-mono truncate flex-1">{p.modelId}</span>
                      <span className="px-2 py-0.5 rounded-full bg-white/10 font-bold">{p.taskType}</span>
                      <span className="text-emerald-500 font-bold tabular-nums">{(p.successRate * 100).toFixed(0)}%</span>
                      <span className="text-muted-foreground tabular-nums">{fmtCost(p.avgCost)}</span>
                      <span className="text-muted-foreground tabular-nums">{Math.round(p.avgLatencyMs)}ms</span>
                      <span className="text-muted-foreground/60">n={p.sampleCount}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* AI 工具操作记录（透明化：用户看清 AI 读/改/跑了什么） */}
            <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 shadow-xl">
              <div className="flex items-center gap-3 pb-6 border-b border-white/10">
                <Wrench className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-bold dark:text-white">{t("stats.toolsTitle")}</h2>
              </div>
              {toolExecs.length === 0 ? (
                <p className="text-sm text-muted-foreground pt-6">{t("stats.toolsEmpty")}</p>
              ) : (
                <div className="pt-4 space-y-2">
                  {toolExecs.map((e) => {
                    const Icon = e.toolName === "bash" ? Terminal
                      : e.toolName === "edit" || e.toolName === "write" ? FileEdit : Eye;
                    const statusColor = e.status === "success" ? "text-emerald-500"
                      : e.status === "denied" ? "text-amber-500" : "text-red-500";
                    return (
                      <div key={e.id} className="flex items-center gap-3 p-3 bg-white/5 rounded-xl text-xs">
                        <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span className="font-mono font-bold">{e.toolName}</span>
                        <span className="text-muted-foreground truncate flex-1">{e.input}</span>
                        <span className={`font-bold ${statusColor}`}>{t(`stats.toolStatus.${e.status}`)}</span>
                        <span className="text-muted-foreground/50 tabular-nums">{e.durationMs}ms</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 阶段 F2：byModel 行展开的"按角色拆分"组件。
 *  - 从 byActorRole 过滤出该 modelId 关联的 roleKind 组（每组内 models 已 F1 聚合函数排序过）
 *  - 角色卡片用 ROLE_COLOR_MAP 配色（orchestrator.ts 单一来源）
 *  - 默认折叠（M2 落实：避免 8 角色平铺长页面；review H2 drill-down 模式本身就在滚动层折叠）
 */
function ModelRoleBreakdown({
  modelId,
  allGroups,
  t,
}: {
  modelId: string;
  allGroups: ActorRoleUsage[];
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  // 过滤该 modelId 关联的角色组（rows[].modelId === modelId）
  const groups = allGroups
    .map((g) => ({
      ...g,
      rows: g.rows.filter((r) => r.modelId === modelId),
    }))
    .filter((g) => g.rows.length > 0);

  // 按 totalCost DESC 排（M2：贵的在前）—— 聚合函数已按 roleKind 内 cost DESC，这里按 group totalCost 再排一次
  groups.sort((a, b) => b.totalCost - a.totalCost);

  if (groups.length === 0) {
    return (
      <div className="px-4 py-3 text-[10px] text-muted-foreground/50 italic border-t border-white/5">
        {t("stats.actorRoleEmptyHint")}
      </div>
    );
  }

  return (
    <div className="px-3 py-3 space-y-2 border-t border-white/5 bg-black/10" data-testid={`byModel-breakdown-${modelId}`}>
      <div className="text-[9px] text-muted-foreground/60 italic px-1">
        {t("stats.byModelDrilldownTitle")}
      </div>
      {groups.map((g) => {
        const row = g.rows[0]!; // 该 group 只有这个 modelId 的 1 行（group 按 roleKind 聚合）
        return <RoleCard key={g.roleKind ?? "null"} group={g} row={row} t={t} />;
      })}
    </div>
  );
}

/**
 * 阶段 F2：单张角色卡片（展开在 ModelRoleBreakdown 内部）。
 *  - getRoleLabel 用 RoleId union 强制穷举（review H3：i18n 拼错不静默）
 *  - 配色用 ROLE_COLOR_MAP（review M1：跨模块视觉锚点）
 */
function RoleCard({
  group,
  row,
  t,
}: {
  group: ActorRoleUsage;
  row: ActorRoleModelUsage;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const label = getRoleLabel(group.roleKind, t);
  const colorClass = getRoleColor(group.roleKind);

  return (
    <div
      data-testid={`role-card-${group.roleKind ?? "null"}`}
      className={`rounded-lg border ${colorClass} p-3 flex items-center justify-between gap-3 text-xs`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-bold truncate">{label}</span>
        <span className="text-[10px] text-muted-foreground/70 shrink-0">
          · {t("stats.calls", { n: group.totalCalls })}
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-muted-foreground tabular-nums">
          {t("stats.actorRoleInputTokensCol")}: {row.inputTokens.toLocaleString()}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {t("stats.actorRoleOutputTokensCol")}: {row.outputTokens.toLocaleString()}
        </span>
        <span className="font-bold tabular-nums">{fmtCost(group.totalCost)}</span>
      </div>
    </div>
  );
}

/** 阶段 F2：解析 roleKind → i18n label（review H3 类型安全） */
function getRoleLabel(
  roleKind: string | null,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  if (roleKind === null) return t("stats.actorRoleUnknown");
  if (roleKind === "stage") return t("stats.stage");
  // 8 RoleId 强制穷举
  const knownRoles: readonly string[] = ROLE_IDS;
  if (knownRoles.includes(roleKind)) {
    return t(`chat.orchestrator.roles.${roleKind}`);
  }
  // 未知 roleKind：dev warning + 兜底显示原字符串
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(`[StatsPage] Unknown roleKind: "${roleKind}" — falling back to raw string`);
  }
  return roleKind;
}

/** 阶段 F2：解析 roleKind → 配色 class（review M1 单一来源） */
function getRoleColor(roleKind: string | null): string {
  if (roleKind === null) return UNKNOWN_COLOR;
  if (roleKind === "stage") return STAGE_COLOR;
  if ((ROLE_IDS as readonly string[]).includes(roleKind)) {
    return ROLE_COLOR[roleKind as RoleId];
  }
  return UNKNOWN_COLOR;
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card className="glass border-white/15 dark:border-white/5 rounded-2xl p-5 shadow-lg space-y-2">
      <div className="flex items-center gap-2 text-muted-foreground text-[10px] font-bold uppercase tracking-wider">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-black dark:text-white tabular-nums">{value}</div>
    </Card>
  );
}