import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, MessageSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/lib/db";

export function ConversationSwitcher({
  conversations,
  activeId,
  onSwitch,
  onNew,
  onDelete,
  onRename,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  function startRename(c: Conversation) {
    setEditingId(c.id);
    setDraft(c.title);
  }

  function commitRename() {
    if (editingId && draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
    setDraft("");
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = conversations.find((c) => c.id === activeId);
  const activeTitle = active?.title || t("chat.untitledChat");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold hover:bg-white/10 transition-colors max-w-[220px]"
        title={activeTitle}
      >
        <MessageSquare className="w-4 h-4 text-primary shrink-0" />
        <span className="truncate">{activeTitle}</span>
        <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 opacity-60 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        // UI 修复（2026-07-02，用户反馈）：这里原来用 `glass`（bg-background/80 + 模糊），
        // 80% 不透明度对一个浮在消息列表上方、承载可点击列表项的下拉菜单来说不够——
        // 底下的对话文字会透出来，跟菜单项文字重叠混在一起看不清。`glass` 适合头部/输入框
        // 这种常驻的背景元素（本来就该让底下内容透出一点营造层次感），但不适合这种浮层菜单，
        // 换成完全不透明的 bg-popover（shadcn 的标准弹层背景色，跟 Select 下拉菜单一致）。
        <div className="absolute top-full left-0 mt-2 w-72 max-h-[26rem] overflow-hidden rounded-2xl bg-popover border border-white/10 shadow-2xl z-50 flex flex-col">
          <div className="p-2 border-b border-white/10">
            {/* 修复（2026-07-03，用户反馈"点新建对话没反应"）：这里原来 disabled={isStreaming}，
                如果 isStreaming 卡在 true 用户永远点不动这个按钮、也没有任何提示。现在
                handleNewChat 内部会在 isStreaming 时先强制停止当前流再新建，所以这个按钮
                不再需要 disabled——见 ChatPage.tsx 的 handleNewChat。 */}
            <button
              type="button"
              onClick={() => {
                onNew();
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition-colors"
            >
              <Plus className="w-4 h-4" />
              {t("chat.newChat")}
            </button>
          </div>
          <div className="px-3 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
            {t("chat.conversations")}
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar p-1.5 pt-0.5 space-y-0.5">
            {conversations.map((c) => (
              <div
                key={c.id}
                onClick={() => {
                  if (editingId === c.id) return;
                  onSwitch(c.id);
                  setOpen(false);
                }}
                className={cn(
                  "group flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer text-sm transition-colors",
                  c.id === activeId ? "bg-primary/10 text-primary font-medium" : "hover:bg-white/5 text-muted-foreground",
                )}
              >
                <MessageSquare className="w-3.5 h-3.5 shrink-0 opacity-70" />
                {editingId === c.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") {
                        setEditingId(null);
                        setDraft("");
                      }
                    }}
                    className="flex-1 min-w-0 bg-white/10 rounded-md px-1.5 py-0.5 text-sm outline-none ring-1 ring-primary/40 text-foreground"
                  />
                ) : (
                  <span className="flex-1 truncate">{c.title || t("chat.untitledChat")}</span>
                )}
                {editingId === c.id ? (
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); commitRename(); }}
                    title={t("common.save")}
                    className="text-primary hover:text-primary/80 transition-colors shrink-0"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(c);
                      }}
                      title={t("chat.renameChat")}
                      className="opacity-0 group-hover:opacity-100 hover:text-primary transition-opacity shrink-0"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(c.id);
                      }}
                      title={t("common.delete")}
                      className="opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
