import { AlertTriangle, GitBranch, Hammer, Route, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolCallView } from "@/lib/work-artifact-views";
import type { WorkflowAuditEventLike } from "@/lib/workflow/audit";
import type { WorkflowSnapshot } from "@/lib/workflow/types";
import type { ChatMessage } from "@/pages/chat/types";
import { deriveWorkflowDiagnostics } from "./derive-workflow-diagnostics";

function item(label: string, value: string | null) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-black uppercase tracking-[0.18em] text-muted-foreground/45">{label}</div>
      <div className="text-[11px] font-semibold text-foreground/85 truncate">{value || "-"}</div>
    </div>
  );
}

function statusClass(status: "ok" | "active" | "missing" | "warning"): string {
  if (status === "ok") return "bg-emerald-400/12 text-emerald-200 border-emerald-400/15";
  if (status === "active") return "bg-blue-400/12 text-blue-200 border-blue-400/15";
  if (status === "warning") return "bg-amber-400/12 text-amber-200 border-amber-400/15";
  return "bg-white/5 text-muted-foreground border-white/5";
}

export function WorkflowDiagnostics({
  workflowSnapshot,
  workflowEvents = [],
  toolCalls,
  messages,
}: {
  workflowSnapshot: WorkflowSnapshot | null;
  workflowEvents?: readonly WorkflowAuditEventLike[];
  toolCalls: readonly ToolCallView[];
  messages: readonly ChatMessage[];
}) {
  const { t } = useTranslation();
  const view = deriveWorkflowDiagnostics({ workflowSnapshot, workflowEvents, toolCalls, messages });

  return (
    <details className="group" open={!!workflowSnapshot}>
      <summary className="cursor-pointer list-none px-4 py-3 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-foreground">
        {t("chat.workPanel.diagnostics.title")}
      </summary>
      <div className="glass rounded-xl border border-white/5 px-3 py-3 space-y-3">
        <div className="grid grid-cols-3 gap-1.5">
          {view.layers.map((layer) => (
            <div key={layer.id} className={`rounded-lg border px-2 py-1.5 min-w-0 ${statusClass(layer.status)}`}>
              <div className="text-[9px] font-black uppercase tracking-[0.14em] truncate">{layer.label}</div>
              <div className="text-[9px] opacity-75 truncate">{layer.detail}</div>
            </div>
          ))}
        </div>

        {!view.hasWorkflow ? (
          <div className="flex items-start gap-2 text-[11px] text-muted-foreground/65">
            <ShieldCheck className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/60 shrink-0" />
            <span>{t("chat.workPanel.diagnostics.noWorkflow")}</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              {item(t("chat.workPanel.diagnostics.phase"), view.phase)}
              {item(t("chat.workPanel.diagnostics.status"), view.status)}
              {item(t("chat.workPanel.diagnostics.mode"), view.executionMode)}
              {item(t("chat.workPanel.diagnostics.objective"), view.objective)}
              {item(t("chat.workPanel.diagnostics.latestEvent"), view.latestWorkflowEvent)}
              {item(t("chat.workPanel.diagnostics.eventCount"), String(view.workflowEventCount))}
            </div>

            <div className="rounded-lg bg-white/5 border border-white/5 p-2 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground/55">
                <Route className="w-3 h-3" />
                {t("chat.workPanel.diagnostics.planSource")}
              </div>
              <div className="text-[11px] text-foreground/80">
                {view.planSource
                  ? `${view.planSource.kind}${view.planSource.path ? ` · ${view.planSource.path}` : ""}`
                  : t("chat.workPanel.diagnostics.noPlanSource")}
              </div>
              {view.planSummary && (
                <div className="text-[10px] leading-relaxed text-muted-foreground/70">{view.planSummary}</div>
              )}
              {view.debateSummary && (
                <div className="text-[10px] leading-relaxed text-accent/80">
                  {t("chat.workPanel.diagnostics.debateBasis")}：{view.debateSummary}
                </div>
              )}
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-white/5 border border-white/5 p-2">
            <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground/55">
              <Hammer className="w-3 h-3" />
              {t("chat.workPanel.diagnostics.tools")}
            </div>
            <div className="mt-1 text-[11px] text-foreground/80">
              {t("chat.workPanel.diagnostics.toolStats", {
                total: view.toolStats.total,
                success: view.toolStats.success,
                error: view.toolStats.error,
                denied: view.toolStats.denied,
              })}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground/70 truncate">
              {view.toolStats.latest || t("chat.workPanel.diagnostics.noTools")}
            </div>
          </div>

          <div className="rounded-lg bg-white/5 border border-white/5 p-2">
            <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground/55">
              <GitBranch className="w-3 h-3" />
              {t("chat.workPanel.diagnostics.fallback")}
            </div>
            <div className="mt-1 text-[11px] text-foreground/80">
              {t("chat.workPanel.diagnostics.fallbackStats", { total: view.fallbackStats.total })}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground/70 truncate">
              {view.fallbackStats.latestModel
                ? `${view.fallbackStats.latestModel}${view.fallbackStats.latestReason ? ` · ${view.fallbackStats.latestReason}` : ""}`
                : t("chat.workPanel.diagnostics.noFallback")}
            </div>
          </div>
        </div>

        {view.planSource?.kind === "debate_degraded" && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-400/15 bg-amber-400/10 px-2 py-2 text-[10px] text-amber-200/85">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{t("chat.workPanel.diagnostics.degradedPlanWarning")}</span>
          </div>
        )}
      </div>
    </details>
  );
}
