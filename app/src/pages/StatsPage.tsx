// StatsPage - v0.9 阶段7：用量与省钱统计（成本趋势 / 按模型 / 缓存 / 模型表现）
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BarChart3, Coins, Sparkles, Activity, Cpu, Wrench, FileEdit, Terminal, Eye } from "lucide-react";
import { Card } from "@/components/ui/card";
import { usageEvents, semanticCache, modelPerformanceStats, toolExecutions, type ModelPerformanceStatRow, type ToolExecutionRow } from "@/lib/db";
import { aggregateUsage, type UsageSummary } from "@/lib/llm/usage-stats";
import { cleanupExpiredCache } from "@/lib/llm/semantic-cache";
import { formatCost as fmtCost } from "@/lib/utils";

export function StatsPage() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [cache, setCache] = useState<{ entries: number; totalHits: number }>({ entries: 0, totalHits: 0 });
  const [perf, setPerf] = useState<ModelPerformanceStatRow[]>([]);
  const [toolExecs, setToolExecs] = useState<ToolExecutionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // 清理过期缓存与统计无依赖，不阻塞首屏
        void cleanupExpiredCache();
        // 只拉近 30 天用量（StatsPage 最长窗口就是 30 天），避免全表扫描
        const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const [rows, cacheStats, perfRows, execs] = await Promise.all([
          usageEvents.list(since),
          semanticCache.stats(),
          modelPerformanceStats.list(),
          toolExecutions.list(30),
        ]);
        setSummary(aggregateUsage(rows));
        setCache(cacheStats);
        setPerf(perfRows);
        setToolExecs(execs);
      } catch {
        setSummary(aggregateUsage([]));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const maxDayCost = Math.max(...(summary?.byDay.map((d) => d.cost) ?? [0]), 0.0001);

  return (
    <div className="h-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="max-w-5xl mx-auto space-y-10 pb-20">
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

            {/* 按模型成本 */}
            <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 shadow-xl">
              <div className="flex items-center gap-3 pb-6 border-b border-white/10">
                <Cpu className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-bold dark:text-white">{t("stats.byModelTitle")}</h2>
              </div>
              {summary!.byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground pt-6">{t("stats.noData")}</p>
              ) : (
                <div className="pt-4 space-y-2">
                  {summary!.byModel.slice(0, 10).map((m) => (
                    <div key={m.modelId} className="flex items-center justify-between gap-4 p-3 bg-white/5 rounded-xl text-sm">
                      <span className="font-mono text-xs truncate flex-1">{m.modelId}</span>
                      <span className="text-muted-foreground text-xs">{t("stats.calls", { n: m.calls })}</span>
                      <span className="font-bold tabular-nums">{fmtCost(m.cost)}</span>
                    </div>
                  ))}
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
