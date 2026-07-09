import { Compass, ListChecks, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  clearIntentDiagnostics,
  readIntentDiagnostics,
  subscribeIntentDiagnostics,
  type IntentDiagnosticsEntry,
} from "@/lib/workflow/intent-diagnostics-buffer";
import { deriveIntentDiagnosticsRows, type IntentDiagnosticsRow } from "./derive-intent-diagnostics";

function layerClass(layer: IntentDiagnosticsRow["layer"]): string {
  if (layer === "L0-rule") return "bg-emerald-400/12 text-emerald-200 border-emerald-400/15";
  if (layer === "L1-semantic") return "bg-blue-400/12 text-blue-200 border-blue-400/15";
  if (layer === "L2-judge") return "bg-purple-400/12 text-purple-200 border-purple-400/15";
  if (layer === "L3-state-machine") return "bg-amber-400/12 text-amber-200 border-amber-400/15";
  return "bg-white/5 text-muted-foreground border-white/5";
}

function useIntentDiagnosticsEntries(): readonly IntentDiagnosticsEntry[] {
  const [entries, setEntries] = useState<readonly IntentDiagnosticsEntry[]>(() => readIntentDiagnostics());
  useEffect(() => {
    const unsubscribe = subscribeIntentDiagnostics((next) => setEntries(next));
    return () => {
      unsubscribe();
    };
  }, []);
  return entries;
}

export function IntentDiagnostics() {
  const { t } = useTranslation();
  const entries = useIntentDiagnosticsEntries();
  const rows = deriveIntentDiagnosticsRows(entries);

  return (
    <details className="group">
      <summary className="cursor-pointer list-none px-4 py-3 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-foreground flex items-center gap-1.5">
        <Compass className="w-3 h-3" />
        {t("chat.workPanel.intentDiagnostics.title")}
        <span className="ml-auto text-[8px] font-mono opacity-60">x{rows.length}</span>
      </summary>
      <div className="glass rounded-xl border border-white/5 px-3 py-3 space-y-2">
        {rows.length === 0 ? (
          <div className="text-[11px] text-muted-foreground/55 px-1 py-3">
            {t("chat.workPanel.intentDiagnostics.empty")}
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.id} className="rounded-lg bg-white/5 border border-white/5 p-2 space-y-1.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] ${layerClass(row.layer)}`}>
                  {row.layerLabel}
                </span>
                <span className="rounded-md bg-primary/12 text-primary border border-primary/15 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em]">
                  {row.actionLabel}
                </span>
                <span className="text-[9px] font-mono text-muted-foreground/60">
                  conf={row.confidenceText}
                </span>
                <span className="ml-auto text-[9px] font-mono text-muted-foreground/45">
                  {row.capturedAt.slice(11, 19)}
                </span>
              </div>
              <div className="text-[10.5px] text-foreground/80 leading-relaxed">
                "{row.userTextExcerpt}"
              </div>
              <div className="text-[10px] text-muted-foreground/70 leading-relaxed">
                {row.reasonText}
              </div>
              {row.matchedExampleText && (
                <div className="flex items-start gap-1.5 text-[10px] text-blue-200/85 leading-relaxed">
                  <ListChecks className="w-3 h-3 mt-0.5 shrink-0" />
                  <span className="break-words">{row.matchedExampleText}</span>
                </div>
              )}
              {row.patchSummary && (
                <div className="text-[10px] text-muted-foreground/65 font-mono leading-relaxed">
                  patch: {row.patchSummary}
                </div>
              )}
            </div>
          ))
        )}
        {rows.length > 0 && (
          <button
            type="button"
            onClick={clearIntentDiagnostics}
            className="text-[9px] font-black uppercase tracking-[0.18em] text-muted-foreground/45 hover:text-foreground flex items-center gap-1 px-1"
          >
            <Trash2 className="w-3 h-3" />
            {t("chat.workPanel.intentDiagnostics.clear")}
          </button>
        )}
      </div>
    </details>
  );
}
