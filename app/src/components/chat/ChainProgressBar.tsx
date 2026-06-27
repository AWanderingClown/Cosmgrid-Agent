// 阶段 E2b — watch 接力进度条
// 数据**单一来源**：从 props 的 chainPlan + executedRoles + skippedRoles + abortedRole 派生
// 不另存 ChatPage state。ChainProgressBar 是纯函数组件，只渲染。

import { useTranslation } from "react-i18next";
import { ROLE_IDS, deriveChainProgress, type RoleId, type RoleProgressState } from "@/lib/llm/orchestrator";
import { Square, Loader2, Check, X, AlertTriangle, PlayCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChainProgressBarProps {
  chainPlan: RoleId[];
  executedRoles: RoleId[];
  skippedRoles: RoleId[];
  abortedRole: RoleId | null;
  /** 是否在跑（用于显示/隐藏中止按钮） */
  running: boolean;
  /** 中止按钮 onClick —— 复用 ChatPage 的 abortRef.current?.abort() */
  onStop: () => void;
}

/** 单个状态 → icon + 颜色类名 */
function stateVisuals(state: RoleProgressState): { Icon: typeof Square; cls: string; anim?: boolean } {
  switch (state) {
    case "start":     return { Icon: PlayCircle, cls: "text-primary/70 bg-primary/5" };
    case "pending":   return { Icon: Square, cls: "text-muted-foreground/30 bg-white/[0.02]" };
    case "executing": return { Icon: Loader2, cls: "text-primary bg-primary/15 ring-1 ring-primary/30", anim: true };
    case "done":      return { Icon: Check, cls: "text-emerald-400 bg-emerald-500/10" };
    case "skipped":   return { Icon: AlertTriangle, cls: "text-amber-500 bg-amber-500/10" };
    case "aborted":   return { Icon: X, cls: "text-rose-400 bg-rose-500/10" };
  }
}

export function ChainProgressBar({
  chainPlan,
  executedRoles,
  skippedRoles,
  abortedRole,
  running,
  onStop,
}: ChainProgressBarProps) {
  const { t } = useTranslation();
  const progress = deriveChainProgress({ chainPlan, executedRoles, skippedRoles, abortedRole });

  return (
    <div className="glass rounded-2xl p-4 border border-white/5 space-y-3" data-testid="chain-progress-bar">
      {/* Header: title + 进度文字 + 中止按钮 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
            {t("chat.orchestrator.chainProgressTitle")}
          </div>
          {progress.totalCount > 0 && (
            <div className="text-[10px] font-bold text-muted-foreground/70">
              {t("chat.orchestrator.chainProgressLabel", { done: progress.doneCount, total: progress.totalCount })}
            </div>
          )}
        </div>
        {running && (
          <button
            type="button"
            onClick={onStop}
            data-testid="chain-stop-button"
            className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 border border-rose-500/20 transition-colors"
          >
            {t("chat.orchestrator.chainStopButton")}
          </button>
        )}
      </div>

      {/* 8 角色方块（按 ROLE_IDS 顺序） */}
      <div className="flex flex-wrap gap-1.5">
        {ROLE_IDS.map((role) => {
          const state = progress.states[role];
          const { Icon, cls, anim } = stateVisuals(state);
          const isInChain = chainPlan.includes(role);
          return (
            <div
              key={role}
              data-testid={`chain-role-${role}`}
              data-state={state}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-bold border transition-all",
                cls,
                state === "pending" && !isInChain ? "opacity-40" : "opacity-100",
              )}
              title={t(`chat.orchestrator.chainRole${state.charAt(0).toUpperCase() + state.slice(1)}`, { role })}
            >
              <Icon className={cn("w-3 h-3 shrink-0", anim && "animate-spin")} />
              <span className="text-[10px]">{role}</span>
            </div>
          );
        })}
      </div>

      {/* 闲置状态提示（无 chainPlan 时） */}
      {progress.totalCount === 0 && !running && (
        <div className="text-[10px] text-muted-foreground/40 italic">
          {t("chat.orchestrator.chainProgressIdle")}
        </div>
      )}
    </div>
  );
}