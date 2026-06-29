import { CheckCircle2, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { FileTab } from "./types";

export function TabBar({ tabs, activePath, onSelect, onClose }: {
  tabs: FileTab[];
  activePath?: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-9 items-center overflow-x-auto border-b border-border bg-foreground/[0.04] custom-scrollbar" role="tablist" aria-label={t("chat.workPanel.openTabs")}>
      {tabs.map((tab) => {
        const active = tab.filePath === activePath;
        const name = tab.displayPath.split("/").pop() || tab.displayPath;
        return (
          <div
            key={tab.filePath}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(tab.filePath)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(tab.filePath);
              }
            }}
            tabIndex={active ? 0 : -1}
            className={cn(
              "group flex h-9 max-w-[190px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 text-xs transition-colors",
              active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
            )}
          >
            {tab.isStreaming ? (
              <Loader2 className="w-3 h-3 shrink-0 animate-spin text-primary" />
            ) : (
              <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-400/70" />
            )}
            <span className="truncate">{name}</span>
            <button
              type="button"
              aria-label={t("chat.workPanel.closeTab", { name })}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.filePath);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onClose(tab.filePath);
                }
              }}
              className="ml-1 rounded p-0.5 opacity-0 hover:bg-foreground/10 group-hover:opacity-100 focus:opacity-100"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
