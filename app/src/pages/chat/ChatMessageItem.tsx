import { Suspense, lazy, memo, useEffect, useState } from "react";
import { Brain, Check, ChevronDown, FolderOpen, Paperclip, Sparkles, Swords, Terminal, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { parseThinking } from "@/lib/parse-thinking";
import { ThinkingLogo } from "@/components/ThinkingLogo";
import { ToolCallCard } from "@/components/chat/ToolCallCard";
import type { ToolCallView } from "@/lib/work-artifact-views";
import type { Attachment } from "@/lib/llm/attachments";
import type { RoleId } from "@/lib/llm/orchestrator";
import type { HarnessWarning, ReceiptContent } from "./types";
import cosmgridLogo from "@/assets/cosmgrid-logo.svg";

const MarkdownText = lazy(() => import("@/components/chat/MarkdownText").then((m) => ({ default: m.MarkdownText })));

const COLLAPSIBLE_ICON = { think: Brain, tool: Terminal, debate: Swords } as const;

const CollapsibleBlock = memo(function CollapsibleBlock({
  content,
  closed,
  streaming,
  variant,
}: {
  content: string;
  closed: boolean;
  streaming: boolean;
  variant: "think" | "tool" | "debate";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const body = content.trim();
  if (!body && closed) return null;
  const live = streaming && !closed;
  const Icon = COLLAPSIBLE_ICON[variant];
  const labelLive = variant === "think" ? t("chat.thinking") : variant === "debate" ? t("chat.debate.processLabel") : t("chat.toolCall");
  const labelDone = variant === "think" ? t("chat.thinkingDone") : variant === "debate" ? t("chat.debate.processLabel") : t("chat.toolCallDone");
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex items-center gap-1.5 text-left text-[11px] font-medium text-primary/55 hover:text-primary/80 transition-colors"
      >
        <Icon className={cn("w-3 h-3 shrink-0", live && "animate-pulse")} />
        <span>{live ? labelLive : labelDone}</span>
        <ChevronDown className={cn("w-3 h-3 shrink-0 opacity-50 transition-transform", open && "rotate-180")} />
      </button>
      {open && body && (
        <div className="mt-1.5 ml-4 text-[11px] leading-relaxed text-muted-foreground/50 whitespace-pre-wrap break-words border-l border-primary/15 pl-3">
          {body}
        </div>
      )}
    </div>
  );
});

export const MessageItem = memo(function MessageItem({
  role,
  text,
  isStreaming,
  elapsedLabel,
  attachments,
  harness,
  roleId,
  chainStep,
  chainDone,
  toolCalls,
  modelLabel,
  onEnableWorkspaceProtection,
}: {
  role: "user" | "assistant";
  text: string;
  isStreaming: boolean;
  elapsedLabel?: string;
  attachments?: Attachment[];
  harness?: HarnessWarning;
  roleId?: RoleId;
  chainStep?: { index: number; total: number };
  chainDone?: boolean;
  toolCalls?: ToolCallView[];
  modelLabel?: string;
  /** 2.1 步骤2/3 修复：非 git 工作文件夹时，工具卡片上"开启修改保护"按钮的回调 */
  onEnableWorkspaceProtection?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const isAssistant = role === "assistant";
  const [stepsOpen, setStepsOpen] = useState(isStreaming);
  useEffect(() => { setStepsOpen(isStreaming); }, [isStreaming]);
  const nodeLabel = isAssistant
    ? roleId
      ? t(`chat.workPanel.chainSteps.${roleId}`)
      : t("chat.workPanel.chainSteps.leader")
    : t("chat.userLabel");
  const segments = isAssistant ? parseThinking(text) : null;
  const visibleText = segments
    ? segments.filter((s) => s.type === "text").map((s) => s.content).join("")
    : text;

  return (
    <div className="group flex gap-4 px-6 py-4 animate-in fade-in slide-in-from-bottom-2 duration-700">
      <div className="flex max-w-4xl mx-auto w-full gap-4">
        <div
          className={cn(
            "w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-110 duration-300",
            !isAssistant ? "bg-gradient-to-br from-primary to-blue-600 text-primary-foreground shadow-lg" : "",
          )}
        >
          {!isAssistant ? (
            <User className="w-5 h-5" />
          ) : (
            <img src={cosmgridLogo} className={cn("w-full h-full object-contain", isStreaming && "animate-pulse-slow")} alt={t("chat.altBot")} />
          )}
        </div>
        <div className={cn("flex-1 space-y-2 min-w-0", isAssistant && "bg-primary/5 rounded-2xl px-5 py-4")}>
          <div className="flex items-center gap-2">
            <span className={cn("text-[10px] font-bold tracking-widest text-muted-foreground/60", !isAssistant && "uppercase")}>
              {nodeLabel}
            </span>
            {isAssistant && modelLabel && (
              <span className="text-[10px] font-medium text-muted-foreground/45">· {modelLabel}</span>
            )}
            {isAssistant && roleId && chainStep && (
              <span className="text-[9px] font-mono rounded-full border border-primary/15 bg-primary/10 text-primary/80 px-2 py-0.5">
                {chainDone ? "✓" : "▶"} {chainStep.index}/{chainStep.total}
              </span>
            )}
          </div>
          {isAssistant && harness && (harness.unverifiedPaths.length > 0 || (harness.unverifiedUrls?.length ?? 0) > 0 || (harness.unverifiedCommands?.length ?? 0) > 0 || harness.pseudoToolNames.length > 0 || !!harness.fabricatedUsageCount) && (
            <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              <div className="font-semibold">⚠️ 内容真实性校验：模型可能编造了内容，请勿轻信</div>
              {harness.unverifiedPaths.length > 0 && (
                <div className="mt-1">
                  引用了但本次对话未实际读取的文件：{harness.unverifiedPaths.slice(0, 5).join("、")}{harness.unverifiedPaths.length > 5 ? " 等" : ""}
                </div>
              )}
              {(harness.unverifiedUrls?.length ?? 0) > 0 && (
                <div className="mt-1">
                  声称抓取过但本次对话未实际抓取成功的网页：{harness.unverifiedUrls!.slice(0, 5).join("、")}{harness.unverifiedUrls!.length > 5 ? " 等" : ""}
                </div>
              )}
              {(harness.unverifiedCommands?.length ?? 0) > 0 && (
                <div className="mt-1">
                  声称运行/搜索过但本次对话没有对应成功记录的内容：{harness.unverifiedCommands!.slice(0, 5).join("、")}{harness.unverifiedCommands!.length > 5 ? " 等" : ""}
                </div>
              )}
              {harness.pseudoToolNames.length > 0 && (
                <div className="mt-1">
                  吐了伪工具调用文本（{harness.pseudoToolNames.join("、")}）——这些不是本应用真工具，未实际执行
                </div>
              )}
              {!!harness.fabricatedUsageCount && (
                <div className="mt-1">
                  声称跑了/用了 {harness.fabricatedUsageCount} 次工具或命令，但本轮没有对应数量的真实工具调用记录
                </div>
              )}
            </div>
          )}
          {isAssistant && toolCalls && toolCalls.length > 0 && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setStepsOpen((o) => !o)}
                className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground/70 hover:text-foreground transition-colors"
              >
                <Check className="w-3 h-3 text-emerald-500 shrink-0" />
                <span>{t("chat.steps.processed", { count: toolCalls.length })}</span>
                <ChevronDown className={cn("w-3 h-3 transition-transform", stepsOpen && "rotate-180")} />
              </button>
              {stepsOpen && (
                <div className="space-y-1">
                  {toolCalls.slice(-20).map((call) => (
                    <ToolCallCard key={call.id} call={call} onEnableProtection={onEnableWorkspaceProtection} />
                  ))}
                </div>
              )}
            </div>
          )}
          <div className={cn("text-sm leading-relaxed break-words", !isAssistant ? "text-foreground font-medium whitespace-pre-wrap" : "text-foreground/90")}>
            {segments
              ? segments.map((s, i) =>
                  s.type === "text" ? (
                    <Suspense key={i} fallback={<span className="whitespace-pre-wrap">{s.content}</span>}>
                      <MarkdownText content={s.content} />
                    </Suspense>
                  ) : (
                    <CollapsibleBlock
                      key={i}
                      variant={s.type === "think" ? "think" : s.type === "debate" ? "debate" : "tool"}
                      content={s.content}
                      closed={s.closed}
                      streaming={isStreaming}
                    />
                  ),
                )
              : text}
            {attachments && attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {attachments.map((a) =>
                  a.kind === "image" ? (
                    <img key={a.id} src={a.dataUrl} alt={a.name} className="w-16 h-16 object-cover rounded-lg border border-white/10" />
                  ) : a.kind === "folder" ? (
                    <span key={a.id} className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded-lg px-2 py-1 border border-primary/30">
                      <FolderOpen className="w-3 h-3" /> {a.name}
                    </span>
                  ) : (
                    <span key={a.id} className="inline-flex items-center gap-1 text-xs bg-white/10 rounded-lg px-2 py-1">
                      <Paperclip className="w-3 h-3" /> {a.name}
                    </span>
                  ),
                )}
              </div>
            )}
            {isStreaming && isAssistant && visibleText !== "" && (
              <span className="inline-block w-2 h-5 ml-1 bg-primary/40 animate-pulse rounded-sm align-middle" />
            )}
            {isStreaming && isAssistant && (
              <div className="flex items-center gap-2 mt-1.5 text-xs font-medium text-primary/70">
                <ThinkingLogo className="w-4 h-4 shrink-0" />
                <span>
                  {visibleText.trim() === "" ? t("chat.thinking") : t("chat.replying")}
                  {elapsedLabel ? ` · ${elapsedLabel}` : ""}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export const ReceiptItem = memo(function ReceiptItem({ receipt }: { receipt: ReceiptContent }) {
  const [open, setOpen] = useState(false);
  const hasDetail = receipt.detail.trim().length > 0;
  return (
    <div className="px-6 py-1.5">
      <div className="max-w-4xl mx-auto w-full">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((v) => !v)}
          className={cn(
            "group flex items-start gap-2 text-left text-[11px] leading-relaxed text-muted-foreground/60 transition-colors",
            hasDetail && "hover:text-muted-foreground cursor-pointer",
          )}
        >
          <Sparkles className="w-3 h-3 mt-[3px] shrink-0 text-primary/50" />
          <span className="font-medium">{receipt.summary}</span>
          {hasDetail && (
            <ChevronDown className={cn("w-3 h-3 mt-[3px] shrink-0 opacity-50 transition-transform", open && "rotate-180")} />
          )}
        </button>
        {open && hasDetail && (
          <div className="mt-1.5 ml-5 text-[11px] leading-relaxed text-muted-foreground/50 whitespace-pre-wrap border-l border-primary/10 pl-3">
            {receipt.detail}
          </div>
        )}
      </div>
    </div>
  );
});
