// 阶段 G：edit 工件的 diff 视图（行级 -/+ 红绿渲染）
// 复用 v0.9 diff-util.ts（行级 diff 算法），复用 MAX_DETAIL_LINES 截断
// 组件 < 80 行（不破"<100 行组件"纪律）
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { computeDiff } from "@/lib/llm/tools/diff-util";
import { cn } from "@/lib/utils";
import { MAX_DETAIL_LINES } from "./constants";

interface DiffViewProps {
  oldText: string;
  newText: string;
  /** 截断阈值（默认 MAX_DETAIL_LINES = 40，work-panel 常量单一来源） */
  maxLines?: number;
}

export function DiffView({ oldText, newText, maxLines = MAX_DETAIL_LINES }: DiffViewProps) {
  const { t } = useTranslation();
  const diff = useMemo(() => computeDiff(oldText, newText), [oldText, newText]);
  const allLines = diff.patch.split("\n");
  const total = allLines.length;
  const truncated = total > maxLines;
  const shown = truncated ? allLines.slice(0, maxLines) : allLines;
  const noChange = diff.added === 0 && diff.removed === 0;

  if (noChange) {
    return (
      <div className="px-3 py-2 text-[10px] text-muted-foreground/50">
        {t("chat.workPanel.diffNoChange")}
      </div>
    );
  }

  return (
    <div className="px-3 pb-3 pt-1" data-testid="diff-view">
      <div className="text-[9px] text-muted-foreground/60 px-1 pb-1 flex items-center justify-between">
        <span>
          <span className="text-emerald-500 font-bold">+{diff.added}</span>
          {" "}
          <span className="text-rose-500 font-bold">−{diff.removed}</span>
        </span>
        {truncated && (
          <span className="text-muted-foreground/50">
            {t("chat.workPanel.diffTooLarge", { total, shown: maxLines })}
          </span>
        )}
      </div>
      <pre className="text-[10px] leading-relaxed font-mono text-muted-foreground/80 whitespace-pre-wrap break-words bg-foreground/[0.04] rounded-lg p-2 max-h-64 overflow-auto custom-scrollbar">
        {shown.map((line, i) => {
          const isAdd = line.startsWith("+");
          const isDel = line.startsWith("-");
          return (
            <div
              key={i}
              className={cn(
                "px-1",
                isAdd && "text-emerald-400 bg-emerald-500/5",
                isDel && "text-rose-400 bg-rose-500/5",
              )}
            >
              {line || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
