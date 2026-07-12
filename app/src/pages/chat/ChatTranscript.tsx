import { Bot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ToolCallView } from "@/lib/work-artifact-views";
import { CooldownErrorDescription } from "./CooldownErrorDescription";
import { MessageItem, ReceiptItem } from "./ChatMessageItem";
import { QueuedMessageItem } from "./QueuedMessageItem";
import { formatElapsed, type StreamActivityPhase } from "./streaming-status";
import type { ChatMessage, PendingSend } from "./types";
import cosmgridLogo from "@/assets/cosmgrid-logo.svg";

export function ChatTranscript({
  availableModelCount,
  messages,
  isStreaming,
  streamActivityPhase,
  pendingQueue,
  inputAreaH,
  streamElapsedMs,
  toolCallsByMessage,
  streamError,
  onEnableWorkspaceProtection,
  onStreamErrorClear,
}: {
  availableModelCount: number;
  messages: ChatMessage[];
  isStreaming: boolean;
  streamActivityPhase: StreamActivityPhase;
  pendingQueue: PendingSend[];
  inputAreaH: number;
  streamElapsedMs: number;
  toolCallsByMessage: Map<string, ToolCallView[]>;
  streamError: string | null;
  /** 2.1 步骤2/3 修复：非 git 工作文件夹时，工具卡片上"开启修改保护"按钮的回调 */
  onEnableWorkspaceProtection?: () => Promise<void>;
  onStreamErrorClear?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {availableModelCount === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-center space-y-6 animate-in fade-in zoom-in duration-1000">
          <div className="w-24 h-24 rounded-[2rem] bg-muted/30 flex items-center justify-center relative">
            <div className="absolute inset-0 bg-primary/20 blur-2xl animate-pulse" />
            <Bot className="w-12 h-12 text-muted-foreground relative z-10" />
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-bold tracking-tight">{t("chat.emptyState.title")}</h2>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              {t("chat.emptyState.desc")}
            </p>
          </div>
          <Button variant="outline" className="rounded-2xl border-primary/20 hover:bg-primary/5">
            {t("chat.emptyState.goToConfig")}
          </Button>
        </div>
      ) : messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full animate-in fade-in duration-1000">
          <div className="relative mb-8">
            <div className="absolute -inset-4 bg-primary/20 blur-3xl opacity-50" />
            <img src={cosmgridLogo} className="w-20 h-20 opacity-20 relative" alt={t("chat.altEmpty")} />
          </div>
          <p className="text-sm font-bold uppercase tracking-[0.4em] text-muted-foreground/30">{t("chat.ready")}</p>
        </div>
      ) : (
        <div style={{ paddingBottom: inputAreaH + 16 }}>
          {messages.map((m) => {
            if (m.kind === "receipt" && m.receipt) {
              return <ReceiptItem key={m.id} receipt={m.receipt} />;
            }
            const isLastAssistant = m.role === "assistant" && m === messages[messages.length - 1];
            const streamingThis = isLastAssistant && isStreaming;
            const showToolCalls = m.role === "assistant" ? toolCallsByMessage.get(m.id) : undefined;
            return (
              <MessageItem
                key={m.id}
                role={m.role}
                text={m.content}
                isStreaming={streamingThis}
                streamActivityPhase={streamingThis ? streamActivityPhase : "idle"}
                elapsedLabel={streamingThis ? formatElapsed(streamElapsedMs) : undefined}
                attachments={m.attachments}
                harness={m.harness}
                roleId={m.roleId}
                chainStep={m.chainStep}
                chainDone={m.chainDone}
                toolCalls={showToolCalls}
                modelLabel={m.modelLabel}
                onEnableWorkspaceProtection={onEnableWorkspaceProtection}
              />
            );
          })}
          {isStreaming && pendingQueue.map((q, i) => (
            <QueuedMessageItem key={`pending-${i}`} text={q.text} attachments={q.attachments} />
          ))}
        </div>
      )}

      {streamError && (
        // UI修复（2026-07-02）：这块原来没有跟消息列表共享 paddingBottom: inputAreaH+16，
        // 滚动到底部时正好卡在悬浮输入框（ChatInputDock）后面被完全遮挡，用户看不到报错内容。
        // 补上同样的底部留白，跟消息列表的可见区域对齐。
        <div className="px-6 py-4" style={{ paddingBottom: inputAreaH + 16 }}>
          <Alert variant="destructive" className="bg-red-500/10 border-red-500/20">
            <AlertDescription className="text-xs font-medium">
              <CooldownErrorDescription message={streamError} onExpired={onStreamErrorClear} />
            </AlertDescription>
          </Alert>
        </div>
      )}
    </>
  );
}
