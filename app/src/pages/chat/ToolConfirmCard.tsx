import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolConfirmRequest } from "@/lib/llm/tools";

/**
 * UI 修复（2026-07-02，用户反馈两轮迭代）：
 * 第一轮从独立悬浮的三段式深色大卡片改成贴输入框的小提示条，用户又反馈"没必要专门起一行，
 * 直接长在'空闲，等你发话'那一行就行"——现在直接替换掉 WorkingStatusBar 那一行的内容，
 * 不额外占地方、不撑高输入框。样式上不再自带边框/背景/内边距（那是独立卡片才需要的），
 * 跟 WorkingStatusBar 的其他状态行（正在工作/执行完毕/空闲）用完全一样的极简单行风格。
 */
export function ToolConfirmCard({
  request,
  onResolve,
}: {
  request: ToolConfirmRequest;
  onResolve: (ok: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-2 text-[11px] text-amber-500">
      <ShieldAlert className="h-3 w-3 shrink-0" />
      <span className="font-semibold shrink-0">{t("chat.tools.confirmHint")}</span>
      <span className="truncate text-muted-foreground">{request.toolName}</span>
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => onResolve(false)}
          className="rounded-md px-2 py-0.5 font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors"
        >
          {t("chat.tools.reject")}
        </button>
        <button
          type="button"
          onClick={() => onResolve(true)}
          className="rounded-md px-2 py-0.5 font-semibold bg-emerald-500/90 text-white hover:bg-emerald-500 transition-colors"
        >
          {t("chat.tools.approve")}
        </button>
      </div>
    </div>
  );
}
