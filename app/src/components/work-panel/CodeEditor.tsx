import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { FileTab } from "./types";

function lineNumberWidth(lineCount: number): string {
  return `${Math.max(2, String(lineCount).length)}ch`;
}

export function CodeEditor({ tab }: { tab: FileTab }) {
  const { t } = useTranslation();
  const lines = useMemo(() => tab.content.split("\n"), [tab.content]);
  const gutterWidth = lineNumberWidth(lines.length);

  return (
    <div
      className="h-full w-full overflow-auto bg-[#0f1117] text-[12px] leading-5 font-mono custom-scrollbar"
      role="region"
      aria-label={t("chat.workPanel.readOnlyCode")}
    >
      <div className="min-w-max py-3">
        {lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              "grid px-3",
              tab.isStreaming && index === lines.length - 1 && "bg-primary/5",
            )}
            style={{ gridTemplateColumns: `${gutterWidth} 1fr` }}
          >
            <span className="select-none pr-4 text-right text-muted-foreground/35">
              {index + 1}
            </span>
            <code className="whitespace-pre text-slate-100">
              {line || " "}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}
