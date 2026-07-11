// Harness 工程实施计划 阶段3 — Evidence Panel（工作面板 dev 模式 4 区块入口）。
//
// 普通用户模式：折叠显示 humanSummary 一行。
// dev 模式：4 区块（声明 / 证据 / 冲突 / 验收决定）。
//
// 视觉规范沿用 `WorkPanelIde` / `WorkflowDiagnostics` 的"9px uppercase tracking-[0.2em]"
// + statusClass() 配色 + <details className="group"> 折叠。

import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, FileText, HelpCircle, XCircle } from "lucide-react";
import type { WorkflowSnapshot } from "@/lib/workflow/types";
import { cn } from "@/lib/utils";
import { deriveEvidenceView } from "./derive-evidence";

interface Props {
  workflowSnapshot: WorkflowSnapshot | null;
  devMode: boolean;
}

export function EvidencePanel({ workflowSnapshot, devMode }: Props) {
  const view = deriveEvidenceView(workflowSnapshot);
  const { t } = useTranslation();

  if (view.status === "absent") {
    return (
      <details className="group rounded-lg border border-border/60 bg-foreground/[0.03]">
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground/80">
          <HelpCircle className="h-3.5 w-3.5" />
          {t("chat.workPanel.evidence.title", "证据链")}
        </summary>
        <div className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground/60">
          {view.humanSummary}
        </div>
      </details>
    );
  }

  const statusIcon =
    view.status === "passes" ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    ) : view.status === "fails" ? (
      <XCircle className="h-3.5 w-3.5 text-rose-400" />
    ) : (
      <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
    );
  const statusLabel =
    view.status === "passes"
      ? t("chat.workPanel.evidence.status.passes", "通过")
      : view.status === "fails"
        ? t("chat.workPanel.evidence.status.fails", "失败")
        : t("chat.workPanel.evidence.status.inconclusive", "证据不足");

  return (
    <details
      open={devMode}
      className="group rounded-lg border border-border/60 bg-foreground/[0.03]"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground/80">
        {statusIcon}
        <span>{t("chat.workPanel.evidence.title", "证据链")}</span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/55">
          {statusLabel}
        </span>
      </summary>
      <div className="space-y-2 border-t border-border/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground/70">
        <p className="text-foreground/85">{view.humanSummary}</p>
        {devMode && (
          <>
            {view.conflicts.length > 0 && (
              <EvidenceSection
                title={t("chat.workPanel.evidence.sections.conflicts", "冲突")}
                accent="text-rose-400"
              >
                {view.conflicts.map((c, i) => (
                  <div key={i} className="rounded border border-rose-500/30 bg-rose-500/5 p-2">
                    <span className="font-mono text-[10px] text-rose-300">[{c.kind}]</span>{" "}
                    <span className="text-foreground/85">{c.text}</span>
                    {c.conflictReason && (
                      <p className="mt-1 text-[10px] text-muted-foreground/60">{c.conflictReason}</p>
                    )}
                  </div>
                ))}
              </EvidenceSection>
            )}
            <EvidenceSection
              title={t("chat.workPanel.evidence.sections.claims", "声明")}
              accent="text-foreground/85"
            >
              <ul className="space-y-1">
                {view.claims.map((c, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <VerdictBadge verdict={c.verdict} />
                    <span className="font-mono text-[10px] text-muted-foreground/55">{c.kind}</span>
                    <span className="truncate">{c.text}</span>
                  </li>
                ))}
              </ul>
            </EvidenceSection>
            <EvidenceSection
              title={t("chat.workPanel.evidence.sections.evidence", "证据")}
              accent="text-foreground/85"
            >
              {view.evidenceIds.length === 0 ? (
                <p className="text-muted-foreground/55">无</p>
              ) : (
                <ul className="space-y-0.5 font-mono text-[10px]">
                  {view.evidenceIds.slice(0, 10).map((id) => (
                    <li key={id}>{id}</li>
                  ))}
                  {view.evidenceIds.length > 10 && (
                    <li className="text-muted-foreground/55">
                      …等 {view.evidenceIds.length} 条
                    </li>
                  )}
                </ul>
              )}
            </EvidenceSection>
            {(view.metCriteria.length > 0 || view.failedCriteria.length > 0) && (
              <EvidenceSection
                title={t("chat.workPanel.evidence.sections.decision", "验收决定")}
                accent="text-foreground/85"
              >
                <div className="flex flex-wrap gap-1.5">
                  {view.metCriteria.map((c) => (
                    <span
                      key={c}
                      className={cn(
                        "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                        "bg-emerald-500/10 text-emerald-300",
                      )}
                    >
                      ✓ {c}
                    </span>
                  ))}
                  {view.failedCriteria.map((c) => (
                    <span
                      key={c}
                      className={cn(
                        "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                        "bg-rose-500/10 text-rose-300",
                      )}
                    >
                      ✗ {c}
                    </span>
                  ))}
                </div>
              </EvidenceSection>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function EvidenceSection({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className={cn("mb-1 text-[10px] font-semibold uppercase tracking-[0.16em]", accent)}>
        <FileText className="mr-1 inline h-3 w-3" />
        {title}
      </h4>
      <div className="pl-4">{children}</div>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: "supported" | "insufficient" | "contradicts" | "unknown" }) {
  const map = {
    supported: { label: "已支持", cls: "bg-emerald-500/15 text-emerald-300" },
    insufficient: { label: "证据不足", cls: "bg-amber-500/15 text-amber-300" },
    contradicts: { label: "与证据冲突", cls: "bg-rose-500/15 text-rose-300" },
    unknown: { label: "无法判定", cls: "bg-muted text-muted-foreground" },
  } as const;
  const m = map[verdict];
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-0.5 text-[9px] font-medium",
        m.cls,
      )}
    >
      {m.label}
    </span>
  );
}