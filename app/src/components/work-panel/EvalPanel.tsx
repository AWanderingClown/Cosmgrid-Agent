// Harness 工程实施计划 阶段4 — Eval Dashboard Panel（工作面板 dev 模式入口）。
//
// 普通用户模式：折叠显示 "暂无评估" 占位。
// dev 模式：4 区块（最新 run 总览 / 11 指标 / cost spike 告警 / 失败类型直方图）。
//
// 视觉规范沿用 EvidencePanel（9px uppercase tracking-[0.2em] + statusClass + <details> 折叠）。

import { AlertTriangle, BarChart3, CheckCircle2, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EvalRunRow, EvalResultRow } from "@/lib/db";
import { cn } from "@/lib/utils";
import { deriveEvalSummary } from "./derive-eval-summary";

interface Props {
  runs: EvalRunRow[];
  results: EvalResultRow[];
  devMode: boolean;
}

export function EvalPanel({ runs, results, devMode }: Props) {
  const view = deriveEvalSummary({ runs, results });
  const { t } = useTranslation();

  if (view.status === "absent") {
    return (
      <details className="group rounded-lg border border-border/60 bg-foreground/[0.03]">
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground/80">
          <BarChart3 className="h-3.5 w-3.5" />
          {t("chat.workPanel.eval.title", "Eval Harness")}
        </summary>
        <div className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground/60">
          暂无评估运行（`pnpm eval:fast` 跑一次）
        </div>
      </details>
    );
  }

  return (
    <details open={devMode} className="group rounded-lg border border-border/60 bg-foreground/[0.03]">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground/80">
        {view.costSpikeAlert ? (
          <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
        )}
        <span>{t("chat.workPanel.eval.title", "Eval Harness")}</span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/55">
          v{view.latestHarnessVersion} · {view.passedCases}/{view.totalCases} passed
        </span>
      </summary>
      <div className="space-y-2 border-t border-border/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground/70">
        {view.costSpikeAlert && (
          <div className="rounded border border-rose-500/30 bg-rose-500/5 p-2 text-rose-300">
            ⚠ cost_per_success 涨幅 &gt; 30% — 真问题还是 reviewer 决定（不阻断）
          </div>
        )}
        {devMode && (
          <>
            <EvalSection
              title={t("chat.workPanel.eval.sections.passRate", "通过率")}
              accent="text-foreground/85"
            >
              <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                <Metric label="completion" value={fmtPct(view.metrics.completionRate)} />
                <Metric label="pass@1" value={fmtPct(view.metrics.passAt1)} />
                <Metric label="pass@3" value={fmtPct(view.metrics.passAt3)} />
                <Metric label="verifier" value={fmtPct(view.metrics.verifierPassRate)} />
                <Metric label="violation" value={fmtPct(view.metrics.harnessViolationRate)} danger />
                <Metric label="context" value={fmtPct(view.metrics.contextContinuityRate)} />
              </div>
            </EvalSection>
            <EvalSection
              title={t("chat.workPanel.eval.sections.costSpike", "成本 / 重试")}
              accent="text-foreground/85"
            >
              <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                <Metric label="cost/success" value={`$${view.metrics.costPerSuccess.toFixed(3)}`} />
                <Metric label="latency" value={`${(view.metrics.latencyPerSuccess / 1000).toFixed(1)}s`} />
                <Metric label="retries" value={view.metrics.retriesPerTask.toFixed(1)} />
                <Metric label="recovery" value={fmtPct(view.metrics.recoveryRate)} />
                <Metric label="interventions" value={String(view.metrics.humanInterventions)} />
              </div>
            </EvalSection>
            {view.failureKinds.length > 0 && (
              <EvalSection
                title="失败类型（top 5）"
                accent="text-rose-300"
              >
                <ul className="space-y-0.5 font-mono text-[10px]">
                  {view.failureKinds.map((f) => (
                    <li key={f.kind} className="flex items-center justify-between">
                      <span className="text-rose-300">{f.kind}</span>
                      <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-200">{f.count}</span>
                    </li>
                  ))}
                </ul>
              </EvalSection>
            )}
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/45">
              <History className="h-3 w-3" />
              runId={view.latestRunId} · status={view.status}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function EvalSection({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className={cn("mb-1 text-[10px] font-semibold uppercase tracking-[0.16em]", accent)}>{title}</h4>
      <div className="pl-1">{children}</div>
    </div>
  );
}

function Metric({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className={cn("rounded-md bg-foreground/[0.04] px-2 py-1", danger && value !== "0%" && "bg-rose-500/10 text-rose-300")}>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground/55">{label}</div>
      <div className="font-mono text-[11px] text-foreground/85">{value}</div>
    </div>
  );
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}