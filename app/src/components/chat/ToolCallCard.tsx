import { CheckCircle2, ChevronDown, FileEdit, FilePlus, FileSearch, GitBranch, Search, ShieldCheck, ShieldAlert, ShieldPlus, Terminal, XCircle, Ban, Clock, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ToolCallView } from "@/lib/work-artifact-views";

const TOOL_ICON = {
  read: FileSearch,
  write: FilePlus,
  edit: FileEdit,
  bash: Terminal,
  glob: Search,
  grep: Search,
  git_read: GitBranch,
} as const;

function statusVisual(status: ToolCallView["status"]) {
  if (status === "success") return { Icon: CheckCircle2, cls: "text-emerald-400" };
  if (status === "warning") return { Icon: ShieldAlert, cls: "text-amber-400" };
  if (status === "denied") return { Icon: Ban, cls: "text-amber-400" };
  if (status === "timeout") return { Icon: Clock, cls: "text-amber-400" };
  if (status === "awaiting_approval") return { Icon: Clock, cls: "text-primary animate-pulse" };
  return { Icon: XCircle, cls: "text-rose-400" };
}

/**
 * 2.1 修复（2026-07-02）：工具卡片显式区分"可撤销 / 不可撤销"。
 * 只对写类工具（write/edit/bash）的成功结果有意义；只读工具（read/glob/grep/git_read）不显示。
 * - ✅ 可撤销：已 git 快照，用户一键回滚
 * - ⚠️ 不可撤销：非 git 仓库 / git 失败，用户必须自己知道这次没保护
 */
function reversibleVisual(call: ToolCallView) {
  // 只对写类工具的成功结果有 reversible 语义
  const writeTools = new Set(["write", "edit", "bash"]);
  if (call.status !== "success" || !writeTools.has(call.toolName)) return null;
  if (call.reversible === true) {
    return { Icon: ShieldCheck, cls: "text-emerald-400", i18nKey: "chat.toolSteps.reversible" };
  }
  // reversible === false 或 undefined 都视为"不可撤销"（对 vibe coder 来说，
  // 模糊就是没保护，必须显式警示）
  return { Icon: ShieldAlert, cls: "text-rose-400", i18nKey: "chat.toolSteps.notReversible" };
}

/**
 * 2.1 步骤2/3 修复（2026-07-02）：出现"不可撤销"警示时，给个能直接点的按钮——
 * 让用户当场给这个工作文件夹开启修改保护（影子 git 仓库），不用自己去找入口。
 * 点一次即可：开启后这个 workspace 的后续写操作都会自动变成可撤销，
 * 这条历史记录本身保持"当时未受保护"的如实状态不变（不倒填）。
 */
export function ToolCallCard({
  call,
  onEnableProtection,
}: {
  call: ToolCallView;
  /** 未传时不显示"开启修改保护"按钮（比如没有 workspace 上下文的场景） */
  onEnableProtection?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [protectState, setProtectState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const Icon = TOOL_ICON[call.toolName as keyof typeof TOOL_ICON] ?? Terminal;
  const { Icon: StatusIcon, cls } = statusVisual(call.status);
  const reversibleBadge = reversibleVisual(call);
  const showProtectButton =
    onEnableProtection && reversibleBadge?.i18nKey === "chat.toolSteps.notReversible" && protectState !== "done";

  async function handleEnableProtection() {
    if (!onEnableProtection || protectState === "loading") return;
    setProtectState("loading");
    try {
      await onEnableProtection();
      setProtectState("done");
    } catch {
      setProtectState("error");
    }
  }

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-border bg-foreground/[0.035]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-foreground/[0.045]"
      >
        <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/55">
          {call.toolName}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/85">
          {t(`chat.toolSteps.${call.summaryKey}`, { ...call.summaryVars, defaultValue: call.shortSummary })}
        </span>
        {reversibleBadge && (
          <span
            className={cn(
              "shrink-0 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-medium",
              reversibleBadge.cls,
              "bg-foreground/[0.06]",
            )}
            title={t(reversibleBadge.i18nKey)}
          >
            <reversibleBadge.Icon className="w-3 h-3" />
            {t(reversibleBadge.i18nKey)}
          </span>
        )}
        <span className="shrink-0 text-[9px] text-muted-foreground/45">{call.durationMs}ms</span>
        <StatusIcon className={cn("w-3.5 h-3.5 shrink-0", cls)} />
        <ChevronDown className={cn("w-3 h-3 shrink-0 text-muted-foreground/45 transition-transform", open && "rotate-180")} />
      </button>
      {showProtectButton && (
        <div className="flex items-center justify-between gap-2 border-t border-border bg-foreground/[0.02] px-3 py-1.5">
          <span className="text-[9px] text-muted-foreground/60">{t("chat.toolSteps.protectHint")}</span>
          <button
            type="button"
            onClick={handleEnableProtection}
            disabled={protectState === "loading"}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[9px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-60"
          >
            {protectState === "loading" ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <ShieldPlus className="w-3 h-3" />
            )}
            {t("chat.toolSteps.enableProtection")}
          </button>
        </div>
      )}
      {protectState === "error" && (
        <div className="border-t border-border bg-rose-500/5 px-3 py-1.5 text-[9px] text-rose-400">
          {t("chat.toolSteps.enableProtectionFailed")}
        </div>
      )}
      {open && (
        <pre className="max-h-44 overflow-auto border-t border-border bg-foreground/[0.045] px-3 py-2 text-[10px] leading-relaxed text-muted-foreground/70 custom-scrollbar">
          {call.detailFull}
        </pre>
      )}
    </div>
  );
}
