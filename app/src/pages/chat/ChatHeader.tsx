import { Cpu, PanelRight, ShieldAlert, Sparkles, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/lib/db";
import type { ModelListItem } from "@/lib/api";
import { ConversationSwitcher } from "./ConversationSwitcher";

interface ChatHeaderProps {
  conversations: Conversation[];
  conversationId: string | null;
  isStreaming: boolean;
  selectedModelId: string;
  availableModels: ModelListItem[];
  panelOpen: boolean;
  lastUsage: { inputTokens: number; outputTokens: number } | null;
  switchNotice: string | null;
  cacheNotice: string | null;
  harnessNotice: string | null;
  onSwitchConversation: (id: string) => void;
  onNewChat: () => void;
  onDeleteConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onModelChange: (id: string) => void;
  onSmartPick: () => void;
  onTogglePanel: () => void;
}

export function ChatHeader({
  conversations,
  conversationId,
  isStreaming,
  selectedModelId,
  availableModels,
  panelOpen,
  lastUsage,
  switchNotice,
  cacheNotice,
  harnessNotice,
  onSwitchConversation,
  onNewChat,
  onDeleteConversation,
  onRenameConversation,
  onModelChange,
  onSmartPick,
  onTogglePanel,
}: ChatHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="px-6 py-3 flex items-center justify-between gap-x-3 gap-y-2 flex-wrap border-b border-white/10 glass z-10">
      <div className="flex items-center gap-3 flex-wrap min-w-0">
        <ConversationSwitcher
          conversations={conversations}
          activeId={conversationId}
          disabled={isStreaming}
          onSwitch={onSwitchConversation}
          onNew={onNewChat}
          onDelete={onDeleteConversation}
          onRename={onRenameConversation}
        />
        <div className="h-5 w-px bg-white/10 shrink-0" />
        <div className="relative group">
          <div className="absolute -inset-1 bg-gradient-to-r from-primary to-accent rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200" />
          <div className="relative flex items-center gap-2 px-3 py-1.5 rounded-xl">
            <Cpu className="w-4 h-4 text-primary shrink-0" />
            <Select value={selectedModelId} onValueChange={onModelChange}>
              <SelectTrigger className="border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:border-0 px-0 h-auto text-xs font-bold gap-1 hover:bg-transparent">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" sideOffset={6} align="start" avoidCollisions={false}>
                {availableModels.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="focus:bg-primary focus:text-primary-foreground">
                    {m.displayName ?? m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onSmartPick}
          className="h-9 px-3 text-xs font-medium hover:bg-primary/10 hover:text-primary transition-all rounded-xl gap-2"
        >
          <div className="p-1 bg-primary/10 rounded-lg group-hover:scale-110 transition-transform">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
          </div>
          {t("chat.smartPick")}
        </Button>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onTogglePanel}
          title={t("chat.workPanel.title")}
          className={cn("hidden xl:flex h-9 w-9 rounded-xl", panelOpen ? "bg-primary/10 text-primary" : "hover:bg-white/10")}
        >
          <PanelRight className="w-4 h-4" />
        </Button>
        {lastUsage && (
          <div className="hidden md:flex items-center gap-3 px-3 py-1 bg-muted/30 rounded-full border border-white/5">
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">{t("chat.usage")}</span>
            <div className="flex gap-2">
              <span className="text-[10px] font-mono text-blue-400">{t("chat.inputTokens", { count: lastUsage.inputTokens })}</span>
              <span className="text-[10px] font-mono text-orange-400">{t("chat.outputTokens", { count: lastUsage.outputTokens })}</span>
            </div>
          </div>
        )}
        {switchNotice && (
          <div className="flex items-center gap-2 px-3 py-1 bg-amber-500/10 text-amber-500 rounded-full border border-amber-500/20 animate-pulse">
            <Zap className="w-3 h-3" />
            <span className="text-[10px] font-bold uppercase">{switchNotice}</span>
          </div>
        )}
        {cacheNotice && (
          <div className="flex items-center gap-2 px-3 py-1 bg-emerald-500/10 text-emerald-500 rounded-full border border-emerald-500/20">
            <Sparkles className="w-3 h-3" />
            <span className="text-[10px] font-bold uppercase">{cacheNotice}</span>
          </div>
        )}
        {harnessNotice && (
          <div className="flex items-center gap-2 px-3 py-1 bg-rose-500/10 text-rose-500 rounded-full border border-rose-500/20 animate-pulse">
            <ShieldAlert className="w-3 h-3" />
            <span className="text-[10px] font-bold uppercase">{harnessNotice}</span>
          </div>
        )}
      </div>
    </header>
  );
}
