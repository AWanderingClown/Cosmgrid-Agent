import { lazy, Suspense, type MouseEvent } from "react";
import { Activity, Cpu, X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { ChainNodeGraph } from "@/components/work-panel/ChainNodeGraph";
import type { ChainNodeView } from "@/components/work-panel/derive-chain-node-graph";
import { WorkArtifacts } from "@/components/work-panel/WorkArtifacts";
import { DebateHistory } from "@/components/work-panel/DebateHistory";
import type { ModelListItem } from "@/lib/api";
import type { WorkArtifact } from "@/lib/work-artifacts";
import { formatElapsed } from "./streaming-status";
import type { ChatMessage } from "./types";

const WorkPanelIde = lazy(() => import("@/components/work-panel/WorkPanelIde").then((m) => ({ default: m.WorkPanelIde })));

interface ChatWorkPanelProps {
  width: number;
  onResizeMouseDown: (event: MouseEvent) => void;
  onClose: () => void;
  nodes: ChainNodeView[];
  availableModels: ModelListItem[];
  disabled: boolean;
  onMainModelChange: (modelId: string) => void;
  onNodeModelChange: (nodeId: string, modelId: string) => void;
  conversationId: string | null;
  workspacePath: string | null;
  artifacts: WorkArtifact[];
  running: boolean;
  streamElapsedMs: number;
  activeModelLabel: string;
  messages: ChatMessage[];
}

export function ChatWorkPanel({
  width,
  onResizeMouseDown,
  onClose,
  nodes,
  availableModels,
  disabled,
  onMainModelChange,
  onNodeModelChange,
  conversationId,
  workspacePath,
  artifacts,
  running,
  streamElapsedMs,
  activeModelLabel,
  messages,
}: ChatWorkPanelProps) {
  const { t } = useTranslation();

  const turns = messages.filter((m) => m.role === "assistant" && (m.modelLabel || m.usage));

  function renderTurnCard({ m, n }: { m: ChatMessage; n: number }) {
    return (
      <div key={m.id} className="glass rounded-xl px-3 py-2 border border-white/5 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/40">
            {t("chat.workPanel.turnLabel", { n })}
          </span>
          {m.switched ? (
            <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase bg-accent/15 text-accent border border-accent/20 flex items-center gap-1">
              <Zap className="w-2.5 h-2.5" /> {t("chat.workPanel.fallback")}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase bg-primary/10 text-primary border border-primary/20">
              {t("chat.workPanel.primary")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs font-bold">
          <Cpu className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{m.modelLabel ?? "-"}</span>
        </div>
        {m.switched && (
          <div className="text-[10px] text-accent/80">{t("chat.workPanel.switchedNote")}</div>
        )}
        {m.usage && (
          <div className="flex gap-3 font-mono text-[10px] text-muted-foreground/60">
            <span>{t("chat.workPanel.inTokens")} {m.usage.inputTokens}</span>
            <span>{t("chat.workPanel.outTokens")} {m.usage.outputTokens}</span>
          </div>
        )}
      </div>
    );
  }

  function renderTokenUsage() {
    if (turns.length === 0) {
      return (
        <div className="text-[11px] text-muted-foreground/40 text-center py-12 uppercase tracking-widest">
          {t("chat.workPanel.empty")}
        </div>
      );
    }
    const totalIn = turns.reduce((s, m) => s + (m.usage?.inputTokens ?? 0), 0);
    const totalOut = turns.reduce((s, m) => s + (m.usage?.outputTokens ?? 0), 0);
    const ordered = turns.map((m, i) => ({ m, n: i + 1 })).reverse();
    const recent = ordered.slice(0, 3);
    const older = ordered.slice(3);
    return (
      <div className="space-y-1.5">
        <div className="px-1 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
          {t("chat.workPanel.tokenUsage")}
        </div>
        <div className="glass rounded-xl px-3 py-2.5 border border-white/5">
          <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 mb-1.5">
            {t("chat.workPanel.sessionTotal")}
          </div>
          <div className="flex gap-4 font-mono text-xs">
            <span className="text-blue-400">{t("chat.workPanel.inTokens")} {totalIn.toLocaleString()}</span>
            <span className="text-orange-400">{t("chat.workPanel.outTokens")} {totalOut.toLocaleString()}</span>
          </div>
        </div>
        {recent.map(renderTurnCard)}
        {older.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer list-none px-1 py-1.5 text-[10px] font-bold text-muted-foreground/50 hover:text-foreground">
              {t("chat.workPanel.showMoreTurns", { count: older.length })}
            </summary>
            <div className="space-y-1.5 mt-1.5">
              {older.map(renderTurnCard)}
            </div>
          </details>
        )}
      </div>
    );
  }

  return (
    <>
      <ResizeHandle onMouseDown={onResizeMouseDown} className="hidden xl:block" />
      <aside style={{ width }} className="shrink-0 glass h-full hidden xl:flex flex-col rounded-3xl overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            <span className="text-xs font-black uppercase tracking-[0.2em]">{t("chat.workPanel.title")}</span>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onClose}
            title={t("chat.workPanel.close")}
            className="h-7 w-7 rounded-lg hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 space-y-2">
          <ChainNodeGraph
            nodes={nodes}
            availableModels={availableModels}
            disabled={disabled}
            onMainModelChange={onMainModelChange}
            onNodeModelChange={onNodeModelChange}
          />
          <Suspense
            fallback={
              <div className="glass rounded-2xl border border-white/5 p-4 text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">
                {t("common.loading")}
              </div>
            }
          >
            <WorkPanelIde
              resetKey={conversationId ?? "new"}
              workspacePath={workspacePath}
              artifacts={artifacts}
              running={running}
              activeLabel={
                running
                  ? `${t("chat.replying")} · ${formatElapsed(streamElapsedMs)} · ${activeModelLabel}`
                  : t("chat.workPanel.idle")
              }
            />
          </Suspense>
          {artifacts.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer list-none px-4 py-3 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-foreground">
                {t("chat.workPanel.artifacts")}
              </summary>
              <div>
                <WorkArtifacts artifacts={artifacts} />
              </div>
            </details>
          )}
          <details className="group">
            <summary className="cursor-pointer list-none px-4 py-3 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-foreground">
              {t("chat.workPanel.debateHistory")}
            </summary>
            <div>
              <DebateHistory availableModels={availableModels} />
            </div>
          </details>
          {renderTokenUsage()}
        </div>
      </aside>
    </>
  );
}
