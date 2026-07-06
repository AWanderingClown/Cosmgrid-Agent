import { CheckCircle2, Clock, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolCallView } from "@/lib/work-artifact-views";

export function WorkingStatusBar({ activeCall, running }: { activeCall?: ToolCallView; running: boolean }) {
  const { t } = useTranslation();
  const activeSummary = activeCall
    ? t(`chat.toolSteps.${activeCall.summaryKey}`, { ...activeCall.summaryVars, defaultValue: activeCall.shortSummary })
    : "";

  // 等待用户确认写操作
  if (activeCall?.status === "awaiting_approval") {
    return (
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-amber-300">
        <Clock className="h-3 w-3" />
        <span className="font-semibold">{t("chat.working.awaitingApproval")}</span>
        <span className="truncate text-muted-foreground">{activeSummary}</span>
      </div>
    );
  }

  // 本轮还在进行
  if (running) {
    // 已有一步落库（落库即完成）→ 显示「执行完毕 · 这一步」，不再转圈。
    // 修正旧 bug：最后一步早已完成，却一直转圈「正在工作 写入 X」自相矛盾。
    if (activeCall) {
      return (
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-emerald-500">
          <CheckCircle2 className="h-3 w-3" />
          <span className="font-semibold">{t("chat.working.done")}</span>
          <span className="truncate text-muted-foreground">{activeSummary}</span>
        </div>
      );
    }
    // 还没调工具、纯生成文字 → 转圈「模型正在回复」，不绑任何工具名
    return (
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-primary">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="font-semibold">{t("chat.working.replying")}</span>
      </div>
    );
  }

  // 本轮结束 → 回到空闲（不残留「正在工作/执行完毕」，以对话区回复为准）
  return (
    <div className="flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground/45">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/70" />
      {t("chat.working.idle")}
    </div>
  );
}
