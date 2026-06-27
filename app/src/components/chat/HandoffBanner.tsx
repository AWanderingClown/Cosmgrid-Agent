// 阶段4 Handoff — 接力路径显示横幅
//
// 用途：main chat 完成后模型调了 handoff_to_X，ChatPage 收到 handoffInfo 后显示。
// 显示内容：路径 leader → architect → frontend（用箭头连接）+ 截断标记（如果 truncated）

import { useTranslation } from "react-i18next";
import { ArrowRight, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface HandoffBannerProps {
  /** 接力路径，如 ["leader", "architect", "frontend"] */
  path: string[];
  /** 链条被 maxHandoffs 截断 */
  truncated?: boolean;
  className?: string;
}

export function HandoffBanner({ path, truncated, className }: HandoffBannerProps) {
  const { t } = useTranslation();

  if (path.length < 2) return null; // 没有 handoff 就不显示

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        "border-primary/30 bg-primary/5",
        truncated && "border-yellow-500/30 bg-yellow-500/5",
        className,
      )}
      data-testid="handoff-banner"
    >
      {truncated ? (
        <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-500" />
      ) : (
        <ArrowRight className="h-4 w-4 shrink-0 text-primary" />
      )}
      <div className="flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {path.map((role, idx) => (
            <span key={`${role}-${idx}`} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-xs",
                  idx === 0
                    ? "bg-primary/20 text-primary"
                    : "bg-secondary text-secondary-foreground",
                )}
              >
                {role}
              </span>
              {idx < path.length - 1 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
            </span>
          ))}
        </div>
        {truncated && (
          <p className="text-xs text-yellow-600 dark:text-yellow-400">
            {t("chat.handoff.truncated", { max: path.length })}
          </p>
        )}
      </div>
    </div>
  );
}