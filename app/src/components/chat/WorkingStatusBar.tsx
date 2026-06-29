import { Clock, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolCallView } from "@/lib/work-artifact-views";

export function WorkingStatusBar({ activeCall, running }: { activeCall?: ToolCallView; running: boolean }) {
  const { t } = useTranslation();
  const activeSummary = activeCall
    ? t(`chat.toolSteps.${activeCall.summaryKey}`, { ...activeCall.summaryVars, defaultValue: activeCall.shortSummary })
    : "";
  if (!activeCall && !running) {
    return (
      <div className="mx-auto flex max-w-4xl items-center gap-2 px-6 py-1.5 text-[10px] text-muted-foreground/45">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/70" />
        {t("chat.working.idle")}
      </div>
    );
  }

  if (activeCall?.status === "awaiting_approval") {
    return (
      <div className="mx-auto flex max-w-4xl items-center gap-2 px-6 py-1.5 text-[11px] text-amber-300">
        <Clock className="h-3 w-3" />
        <span className="font-semibold">{t("chat.working.awaitingApproval")}</span>
        <span className="truncate text-muted-foreground">{activeSummary}</span>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl items-center gap-2 px-6 py-1.5 text-[11px] text-primary">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span className="font-semibold">{t("chat.working.working")}</span>
      {activeCall && <span className="truncate text-muted-foreground">{activeSummary}</span>}
    </div>
  );
}
