import { ListChecks } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { NextAction } from "@/lib/workflow/types";

/**
 * Task #9（2026-07-15）：workflow reducer 早就算出了 nextActions/pendingDecision（哪个下一步
 * 推荐、风险高低、大概要花多少），但一直没有 UI 消费——用户只能靠打字，再指望 intent
 * classifier 猜中是哪个选项，猜错了要么走错分支要么卡在 waiting_user 里出不去。
 *
 * 这张卡片直接把 nextActions 渲成按钮，点击走 applyNextActionChoice（确定性推进，不经过
 * LLM 分类器）。跟 AskUserCard/ToolConfirmCard 同一个视觉语系、同一个槽位（贴输入框），
 * 但语义不同：那两张是"有个工具调用在等你"，这张是"上一步做完了，工作流在等你选下一步"。
 */
export function NextActionsCard({
  actions,
  onPick,
}: {
  actions: NextAction[];
  onPick: (actionId: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-primary/25 bg-primary/5 px-3 py-2.5 text-[11px]">
      <div className="flex items-center gap-1.5 font-semibold text-primary">
        <ListChecks className="h-3 w-3 shrink-0" />
        <span>{t("chat.workflow.nextActions.title")}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            title={action.reason}
            // LOW（reviewer 复检发现）：title 只在鼠标悬浮时出现，屏幕阅读器不保证读、触屏
            // 设备也看不到——action.reason 是帮用户判断"为什么推荐/不推荐"的关键信息，
            // 用 aria-describedby 指向一个视觉隐藏的 span 补充给 AT，不用 aria-label
            // 是因为 aria-label 会整个替换按钮的可访问名字，把按钮文案本身（t(action.labelKey)）
            // 也一起吞掉。
            aria-describedby={action.reason ? `next-action-reason-${action.id}` : undefined}
            onClick={() => onPick(action.id)}
            className={cn(
              "rounded-lg border px-2.5 py-1 font-medium transition-colors",
              action.recommended
                ? "border-primary/50 bg-primary/15 text-primary hover:bg-primary/25"
                : "border-primary/20 bg-background/80 text-foreground/80 hover:border-primary/50 hover:bg-primary/10 hover:text-primary",
            )}
          >
            {t(action.labelKey)}
            {action.recommended && (
              <span className="ml-1 text-[8px] uppercase tracking-wide opacity-70">
                {t("chat.workflow.nextActions.recommended")}
              </span>
            )}
            {action.reason && (
              <span id={`next-action-reason-${action.id}`} className="sr-only">
                {action.reason}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
