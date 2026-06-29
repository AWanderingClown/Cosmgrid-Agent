import { CheckCircle2, ChevronDown, FileEdit, FilePlus, FileSearch, GitBranch, Search, Terminal, XCircle, Ban, Clock } from "lucide-react";
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
  if (status === "denied") return { Icon: Ban, cls: "text-amber-400" };
  if (status === "awaiting_approval") return { Icon: Clock, cls: "text-primary animate-pulse" };
  return { Icon: XCircle, cls: "text-rose-400" };
}

export function ToolCallCard({ call }: { call: ToolCallView }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICON[call.toolName as keyof typeof TOOL_ICON] ?? Terminal;
  const { Icon: StatusIcon, cls } = statusVisual(call.status);

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
        <span className="shrink-0 text-[9px] text-muted-foreground/45">{call.durationMs}ms</span>
        <StatusIcon className={cn("w-3.5 h-3.5 shrink-0", cls)} />
        <ChevronDown className={cn("w-3 h-3 shrink-0 text-muted-foreground/45 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <pre className="max-h-44 overflow-auto border-t border-border bg-foreground/[0.045] px-3 py-2 text-[10px] leading-relaxed text-muted-foreground/70 custom-scrollbar">
          {call.detailFull}
        </pre>
      )}
    </div>
  );
}
