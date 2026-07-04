// 2026-07-05 加：debate_sessions 表原来只写不读——每次对弈结果都存进 SQLite，
// 但没有任何界面能让用户回头翻看历史对弈。这里补上查看入口，复用 WorkArtifacts.tsx
// 的展开/折叠卡片视觉模式，保持右侧工作面板风格一致。
import { memo, useEffect, useState } from "react";
import { ChevronDown, MessagesSquare, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { debateSessions, type DebateSessionRow } from "@/lib/db";
import type { ModelListItem } from "@/lib/api";
import { useConfirm } from "@/components/ui/confirm-dialog";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

const DebateHistoryItem = memo(function DebateHistoryItem({
  session,
  availableModels,
  onDeleted,
}: {
  session: DebateSessionRow;
  availableModels: ModelListItem[];
  onDeleted: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const [open, setOpen] = useState(false);

  const nameFor = (modelId: string) => {
    const found = availableModels.find((m) => m.id === modelId);
    return found?.displayName || found?.name || modelId;
  };

  async function handleDelete() {
    const ok = await confirm({
      description: t("chat.workPanel.debateHistoryDeleteConfirm"),
      destructive: true,
    });
    if (!ok) return;
    await debateSessions.delete(session.id);
    onDeleted(session.id);
  }

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/5"
      >
        <MessagesSquare className="w-3.5 h-3.5 shrink-0 text-primary/70" />
        <span className="text-[11px] truncate flex-1">{session.topic}</span>
        <span className="text-[9px] text-muted-foreground/50 font-mono shrink-0">{formatDate(session.createdAt)}</span>
        <ChevronDown className={cn("w-3 h-3 shrink-0 opacity-50 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          <div className="space-y-1.5">
            {session.rounds.map((r, i) => (
              <div key={i} className="rounded-lg bg-foreground/[0.04] p-2">
                <div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50 mb-1">
                  <span>{r.role}</span>
                  <span className="font-mono normal-case">{nameFor(r.modelId)}</span>
                </div>
                <p className="text-[10px] leading-relaxed text-muted-foreground/70 whitespace-pre-wrap break-words line-clamp-6">
                  {r.content}
                </p>
              </div>
            ))}
          </div>
          {session.finalSolution && (
            <div className="rounded-lg border border-primary/20 bg-primary/[0.04] p-2">
              <div className="text-[9px] font-bold uppercase tracking-widest text-primary/70 mb-1">
                {t("chat.workPanel.debateHistoryFinal")}
              </div>
              <p className="text-[10px] leading-relaxed whitespace-pre-wrap break-words line-clamp-8">
                {session.finalSolution}
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={() => void handleDelete()}
            className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40 hover:text-red-400"
          >
            <Trash2 className="w-3 h-3" /> {t("common.delete")}
          </button>
        </div>
      )}
    </div>
  );
});

export const DebateHistory = memo(function DebateHistory({ availableModels }: { availableModels: ModelListItem[] }) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<DebateSessionRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    debateSessions.list(20).then((rows) => {
      if (!cancelled) setSessions(rows);
    }).catch(() => {
      if (!cancelled) setSessions([]);
    });
    return () => { cancelled = true; };
  }, []);

  function handleDeleted(id: string) {
    setSessions((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
  }

  if (sessions === null) {
    return (
      <div className="text-[11px] text-muted-foreground/40 text-center py-6 uppercase tracking-widest">
        {t("common.loading")}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground/40 text-center py-6 uppercase tracking-widest">
        {t("chat.workPanel.debateHistoryEmpty")}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {sessions.map((s) => (
        <DebateHistoryItem key={s.id} session={s} availableModels={availableModels} onDeleted={handleDeleted} />
      ))}
    </div>
  );
});
