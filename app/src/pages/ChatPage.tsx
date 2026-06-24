// ChatPage - 重构为 "Cosmic Cyber" 视觉风格
import { memo, useEffect, useRef, useState } from "react";
import { Bot, Send, Square, User, Zap, Sparkles, Cpu, PanelRight, X, Activity, Swords, Plus, Trash2, MessageSquare, ChevronDown, Pencil, Check, Pin, FolderOpen, Lock, ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePanelResize, ResizeHandle } from "@/components/ui/resize-handle";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { type ModelListItem, type CredentialListItem } from "@/lib/api";
import { models as dbModels, apiCredentials as dbCredentials, conversations as dbConversations, messages as dbMessages, type Conversation, type DbMessage } from "@/lib/db";
import { createDefaultToolRegistry, buildAiSdkTools, type ToolConfirmRequest } from "@/lib/llm/tools";
import { buildWorkspacePreamble } from "@/lib/llm/workspace-context";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getApiKey } from "@/lib/keystore";
import { streamWithFallback, toModelEndpoint, type StreamUsage } from "@/lib/llm/chat-fallback";
import { pickBestModelForRole, rankFallbackModels, scoreModelForRole } from "@/lib/llm/model-capabilities";
import { applyOutcomeForLatest } from "@/lib/llm/outcome-tracker";
import { isCliProviderType } from "@/lib/llm/cli-protocol";
import { classifyMessageComplexity } from "@/lib/llm/message-router";
import { shouldSuggestDebate } from "@/lib/llm/debate-suggester";
import { routeMessage } from "@/lib/llm/smart-router";
import { isSmartRoutingEnabled } from "@/lib/app-settings";
import { lookupCache, writeCache } from "@/lib/llm/semantic-cache";
import { compressHistory, type ChatMsg } from "@/lib/llm/context-compressor";
import { buildTimePreamble } from "@/lib/llm/context-preamble";
import { classifyLlmError } from "@/lib/llm/error-classifier";
import {
  planNodes,
  resolveOrchestration,
  diffOrchestration,
  currentNode,
  pinModelToCurrentNode,
  pinModelToNode,
  pickOrchestratorModel,
  serializeOrchestration,
  parseOrchestration,
  type OrchestrationState,
  type OrchestrationTurn,
  type OrchestrationChange,
} from "@/lib/llm/orchestrator";
import { getLanguageModel } from "@/lib/llm/provider-factory";
import { ThinkingLogo } from "@/components/ThinkingLogo";
import cosmgridLogo from "@/assets/cosmgrid-logo.svg";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 工作面板用：这一轮实际用了哪个模型（展示名） */
  modelLabel?: string;
  /** 是否因限额/失败自动切到了备用模型 */
  switched?: boolean;
  /** 切到了哪个模型 */
  switchedTo?: string;
  /** 这一轮的 token 用量 */
  usage?: { inputTokens: number; outputTokens: number };
  /** 消息形态：普通对话 vs 编排者折叠回执 */
  kind?: "chat" | "receipt";
  /** kind==="receipt" 时的回执内容（一行小字 + 点开详情） */
  receipt?: ReceiptContent;
}

/** 编排者折叠回执：一行摘要 + 可展开详情 */
interface ReceiptContent {
  summary: string;
  detail: string;
}

type ChatUsage = StreamUsage;

/** 安全解析 role="note" 消息存的回执 JSON（坏数据返回 null） */
function parseReceipt(content: string): ReceiptContent | null {
  try {
    const obj = JSON.parse(content) as unknown;
    if (obj && typeof obj === "object" && typeof (obj as ReceiptContent).summary === "string") {
      const r = obj as ReceiptContent;
      return { summary: r.summary, detail: typeof r.detail === "string" ? r.detail : "" };
    }
    return null;
  } catch {
    return null;
  }
}

/** 把落库的消息映射回 UI 的 ChatMessage（恢复历史 / 切换会话复用）。
 *  role="note" 是编排者折叠回执，映射成 kind:"receipt"（坏数据丢弃）。 */
function dbMessagesToChat(hist: DbMessage[], models: ModelListItem[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of hist) {
    if (m.role === "note") {
      const receipt = parseReceipt(m.content);
      if (receipt) out.push({ id: m.id, role: "assistant", content: "", kind: "receipt", receipt });
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    out.push({
      id: m.id,
      role: m.role,
      content: m.content,
      kind: "chat",
      modelLabel: (m.modelId ? models.find((x) => x.id === m.modelId)?.displayName : undefined) ?? undefined,
      usage: m.outputTokens > 0 ? { inputTokens: m.inputTokens, outputTokens: m.outputTokens } : undefined,
    });
  }
  return out;
}

/** 把毫秒格式化成 "3s" / "1m 5s"，给"思考中/回复中"计时用 */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

const MessageItem = memo(function MessageItem({
  role,
  text,
  isStreaming,
  elapsedLabel,
}: {
  role: "user" | "assistant";
  text: string;
  isStreaming: boolean;
  /** 流式进行时的计时文案（如 "5s"），让用户看到"模型在工作/思考"，慢模型也不慌 */
  elapsedLabel?: string;
}) {
  const { t } = useTranslation();
  const isAssistant = role === "assistant";

  return (
    <div className="group flex gap-4 px-6 py-4 animate-in fade-in slide-in-from-bottom-2 duration-700">
      <div className="flex max-w-4xl mx-auto w-full gap-4">
        <div
          className={cn(
            "w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-110 duration-300",
            // 头像摆正（去掉旋转）；助手头像直接用 logo 源图，不要白底/边框/阴影
            !isAssistant
              ? "bg-gradient-to-br from-primary to-blue-600 text-primary-foreground shadow-lg"
              : "",
          )}
        >
          {!isAssistant ? (
            <User className="w-5 h-5" />
          ) : (
            <img src={cosmgridLogo} className={cn("w-full h-full object-contain", isStreaming && "animate-pulse-slow")} alt={t("chat.altBot")} />
          )}
        </div>
        <div className={cn(
          "flex-1 space-y-2 min-w-0",
          // AI 回答用圆角卡片承载淡蓝底（不再是整行直角色带）；用户消息保持透明
          isAssistant && "bg-primary/5 rounded-2xl px-5 py-4",
        )}>
          <div className="flex items-center gap-2">
            <span className={cn(
              "text-[10px] font-bold tracking-widest text-muted-foreground/60",
              // 助手名要保留大小写 "CosmGrid Ai"，不强制大写；用户标签是中文不受影响
              !isAssistant && "uppercase",
            )}>
              {isAssistant ? t("chat.assistantLabel") : t("chat.userLabel")}
            </span>
          </div>
          <div
            className={cn(
              "text-sm leading-relaxed whitespace-pre-wrap break-words",
              !isAssistant ? "text-foreground font-medium" : "text-foreground/90",
            )}
          >
            {text}
            {isStreaming && isAssistant && text !== "" && (
              <span className="inline-block w-2 h-5 ml-1 bg-primary/40 animate-pulse rounded-sm align-middle" />
            )}
            {/* 思考中/回复中 + 计时：让用户明确感知"模型在工作"，慢模型/卡住也一眼可辨 */}
            {isStreaming && isAssistant && (
              <div className="flex items-center gap-2 mt-1.5 text-xs font-medium text-primary/70">
                <ThinkingLogo className="w-4 h-4 shrink-0" />
                <span>
                  {text === "" ? t("chat.thinking") : t("chat.replying")}
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

/** 编排者折叠回执：默认一行小字（✦ 摘要 ›），点开展开"判断依据"。
 *  无感但可见——对齐产品「默认折叠的工作回执」原则。 */
const ReceiptItem = memo(function ReceiptItem({ receipt }: { receipt: ReceiptContent }) {
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

/** 会话切换下拉：顶部栏里点开 = 新建 + 历史会话列表（切换 / 删除）。
 *  取代旧的「第 2 列会话侧栏」，把横向空间还给聊天；会话仍一键可达。 */
function ConversationSwitcher({
  conversations,
  activeId,
  disabled,
  onSwitch,
  onNew,
  onDelete,
  onRename,
}: {
  conversations: Conversation[];
  activeId: string | null;
  disabled: boolean;
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

  // 点面板外部 / 按 Esc 关闭
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
        <div className="absolute top-full left-0 mt-2 w-72 max-h-[26rem] overflow-hidden rounded-2xl glass border border-white/10 shadow-2xl z-50 flex flex-col">
          <div className="p-2 border-b border-white/10">
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                onNew();
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 disabled:opacity-50 transition-colors"
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

// 工具权限三档：只读 → 确认写 → 自动。默认 read，最安全。
type PermissionMode = "read" | "confirm" | "auto";

interface ChatPageProps {
  /** 用户在输入框写下"多方案权衡"类问题时，点"开对弈"会带着这条话题跳到对弈页 */
  onOpenDebate?: (topic: string) => void;
  /** 当前是否停留在聊天页（所有页面常驻挂载，靠这个判断"切回来了"以刷新模型列表） */
  active?: boolean;
}

export function ChatPage({ onOpenDebate, active = true }: ChatPageProps = {}) {
  const { t } = useTranslation();
  const { confirm, alert } = useConfirm();
  const [availableModels, setAvailableModels] = useState<ModelListItem[]>([]);
  const [credentials, setCredentials] = useState<CredentialListItem[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationList, setConversationList] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamElapsedMs, setStreamElapsedMs] = useState(0);
  // 消息队列：模型回复时用户还能继续发，发的句子排队，模型回完自动串行处理（不打断、不中断工作）
  const [pendingQueue, setPendingQueue] = useState<string[]>([]);
  const drainingRef = useRef(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<ChatUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [showDebateHint, setShowDebateHint] = useState(false);

  // 工作文件夹 + 工具权限档（产品真北：让主对话能在本地真干活，不只是聊天）。
  // permissionMode：read=只读(读/搜/git-read) | confirm=写操作逐个确认 | auto=写操作不弹窗。
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("read");
  const [pendingConfirm, setPendingConfirm] = useState<ToolConfirmRequest | null>(null);
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null);
  // 编排者节点状态（后台滚动更新）。用 ref 镜像最新值，供 handleSend 闭包同步读取（避免 stale state）。
  const [orchestration, setOrchestration] = useState<OrchestrationState | null>(null);
  const orchestrationRef = useRef<OrchestrationState | null>(null);
  function applyOrchestration(next: OrchestrationState | null) {
    orchestrationRef.current = next;
    setOrchestration(next);
  }
  // 镜像当前会话 id，供后台编排回调判断"用户是否已切走会话"（避免回执落到错的会话）
  const conversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
  const workPanel = usePanelResize({ initial: 320, min: 240, max: 560, edge: "left" });

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // 流式计时：开始回复时起算，每 200ms 更新，停了归零。给"思考中/回复中 · Xs"用。
  useEffect(() => {
    if (!isStreaming) {
      setStreamElapsedMs(0);
      return;
    }
    const start = Date.now();
    setStreamElapsedMs(0);
    const id = setInterval(() => setStreamElapsedMs(Date.now() - start), 200);
    return () => clearInterval(id);
  }, [isStreaming]);

  // 拉取启用的模型 + 凭证并更新状态，返回模型列表。挂载时与"切回聊天页"时都用它，
  // 保证刚在供应商页新增/删除的模型能立刻反映到下拉里（不用重启 app）。
  // 选中的模型若仍在列表里就保留，否则回退到第一个。
  async function loadModelsAndCreds(): Promise<ModelListItem[]> {
    const [modelsRes, credsRes] = await Promise.all([
      dbModels.listEnabled(),
      dbCredentials.list(),
    ]);
    const ml = modelsRes.map((m) => ({
      id: m.id,
      name: m.name,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      enabled: m.enabled,
      workRoles: m.workRoles,
      capabilityScore: m.capabilityScore,
      providerId: m.providerId,
      provider: m.provider,
    }));
    const cl = credsRes.map((c) => ({
      id: c.id,
      name: c.name,
      baseUrl: c.baseUrl,
      enabled: c.enabled,
      providerId: c.providerId,
      provider: c.provider ?? { name: "", type: "" },
      defaultModelId: c.defaultModelId,
    }));
    setAvailableModels(ml);
    setCredentials(cl);
    setSelectedModelId((prev) => (prev && ml.some((m) => m.id === prev) ? prev : (ml[0]?.id ?? "")));
    return ml;
  }

  // 切回聊天页时刷新模型列表（首次激活由下面的挂载 effect 负责，这里跳过避免重复拉取）。
  const activatedOnceRef = useRef(false);
  useEffect(() => {
    if (!active) return;
    if (!activatedOnceRef.current) {
      activatedOnceRef.current = true;
      return;
    }
    void loadModelsAndCreds().catch(() => {});
  }, [active]);

  useEffect(() => {
    void (async () => {
      try {
        const ml = await loadModelsAndCreds();

        // 主对话多会话：列出全部主对话，没有就建一条，恢复最近一条的历史（关 app 不丢上下文）
        let list = await dbConversations.listMainChats();
        if (list.length === 0) {
          await dbConversations.getOrCreateMainChat(ml[0]?.id ?? null, t("chat.untitledChat"));
          list = await dbConversations.listMainChats();
        }
        setConversationList(list);
        const activeConv = list[0]!;
        setConversationId(activeConv.id);
        setWorkspacePath(activeConv.workspacePath);
        const hist = await dbMessages.listByConversation(activeConv.id);
        setMessages(dbMessagesToChat(hist, ml));
        try {
          applyOrchestration(parseOrchestration(await dbConversations.getOrchestration(activeConv.id)));
        } catch {
          applyOrchestration(null);
        }
        setLoadError(null);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : t("chat.loadError"));
      }
    })();
  }, []);

  // 写操作确认通道：工具运行到写/执行时调 requestConfirm，弹窗等用户按下确认/拒绝。
  function requestConfirm(req: ToolConfirmRequest): Promise<boolean> {
    return new Promise((resolve) => {
      setPendingConfirm(req);
      confirmResolverRef.current = resolve;
    });
  }
  function resolveConfirm(ok: boolean) {
    confirmResolverRef.current?.(ok);
    confirmResolverRef.current = null;
    setPendingConfirm(null);
  }

  // 选/换工作文件夹（系统原生目录选择器），绑到当前会话并落库。
  async function chooseWorkspace() {
    if (isStreaming) return;
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: t("chat.workspace.pickTitle") });
      if (typeof picked !== "string") return; // 用户取消
      setWorkspacePath(picked);
      setConversationList((prev) => prev.map((c) => (c.id === conversationId ? { ...c, workspacePath: picked } : c)));
      if (conversationId) await dbConversations.setWorkspacePath(conversationId, picked);
    } catch {
      // 选择器异常/取消不阻断对话
    }
  }

  // 解绑工作文件夹，权限退回最安全的只读。
  async function clearWorkspace() {
    if (isStreaming) return;
    setWorkspacePath(null);
    setPermissionMode("read");
    setConversationList((prev) => prev.map((c) => (c.id === conversationId ? { ...c, workspacePath: null } : c)));
    if (conversationId) await dbConversations.setWorkspacePath(conversationId, null);
  }

  async function handleNewChat() {
    if (isStreaming) return;
    try {
      const conv = await dbConversations.create({ title: t("chat.untitledChat"), defaultModelId: selectedModelId || null, projectId: null });
      setConversationList((prev) => [conv, ...prev]);
      setConversationId(conv.id);
      setWorkspacePath(null);
      setMessages([]);
      applyOrchestration(null);
      setPendingQueue([]);
      setStreamError(null);
      setSwitchNotice(null);
      setCacheNotice(null);
    } catch {
      // 建会话失败不阻断
    }
  }

  async function switchConversation(id: string) {
    if (id === conversationId || isStreaming) return;
    setConversationId(id);
    setWorkspacePath(conversationList.find((c) => c.id === id)?.workspacePath ?? null);
    setPendingQueue([]);
    setStreamError(null);
    setSwitchNotice(null);
    setCacheNotice(null);
    try {
      const hist = await dbMessages.listByConversation(id);
      setMessages(dbMessagesToChat(hist, availableModels));
    } catch {
      setMessages([]);
    }
    try {
      applyOrchestration(parseOrchestration(await dbConversations.getOrchestration(id)));
    } catch {
      applyOrchestration(null);
    }
  }

  async function handleDeleteConversation(id: string) {
    if (isStreaming) return;
    if (!(await confirm({ description: t("chat.deleteConvConfirm"), destructive: true }))) return;
    try {
      await dbConversations.delete(id);
    } catch {
      // 删库失败也继续更新 UI
    }
    const remaining = conversationList.filter((c) => c.id !== id);
    if (remaining.length === 0) {
      const conv = await dbConversations.create({ title: t("chat.untitledChat"), defaultModelId: selectedModelId || null, projectId: null });
      setConversationList([conv]);
      setConversationId(conv.id);
      setWorkspacePath(null);
      setMessages([]);
      applyOrchestration(null);
      return;
    }
    setConversationList(remaining);
    if (id === conversationId) {
      const next = remaining[0]!;
      setConversationId(next.id);
      setWorkspacePath(next.workspacePath);
      try {
        const hist = await dbMessages.listByConversation(next.id);
        setMessages(dbMessagesToChat(hist, availableModels));
      } catch {
        setMessages([]);
      }
      try {
        applyOrchestration(parseOrchestration(await dbConversations.getOrchestration(next.id)));
      } catch {
        applyOrchestration(null);
      }
    }
  }

  async function handleRenameConversation(id: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    // 先乐观更新 UI，再落库（落库失败不回滚，下次加载以库为准）
    setConversationList((prev) => prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
    try {
      await dbConversations.rename(id, trimmed);
    } catch {
      // 改名落库失败不阻断
    }
  }

  async function handleSend(text: string) {
    // 编排自动挡：当前节点已绑定模型 → 本轮就用它（上一轮后台编排已定好，零延迟）。
    // 直接走 setSelectedModelId 让 UI 跟上，但**不经 handleModelChange**——那是用户手动切的路径，
    // 会记 switched_up 负反馈；系统自己换的不能污染评分。
    const activeNode = currentNode(orchestrationRef.current);
    const nodeModelId = activeNode?.modelId ?? null;
    const effectiveId =
      nodeModelId && availableModels.some((m) => m.id === nodeModelId) ? nodeModelId : selectedModelId;
    const model = availableModels.find((m) => m.id === effectiveId);
    if (!model || isStreaming) return;
    if (effectiveId !== selectedModelId) setSelectedModelId(effectiveId);

    // 首条消息：用它给会话自动命名
    const isFirstMessage = messages.length === 0;

    // v0.9 阶段7：这一回合是否启用 v2（查缓存/压缩/写缓存）——入口读一次，全程一致
    const smart = isSmartRoutingEnabled();

    const cred = credentials.find((c) => c.providerId === model.providerId);
    if (!cred) {
      setStreamError(t("chat.noCredential"));
      return;
    }

    // CLI 引擎走本机订阅登录态，没有 API Key；API 直连才需要取 Key
    const primaryIsCli = isCliProviderType(model.provider?.type ?? "");
    const apiKey = primaryIsCli ? "" : ((await getApiKey(cred.id)) ?? "");
    if (!primaryIsCli && !apiKey) {
      setStreamError(t("chat.noApiKey"));
      return;
    }

    // 主对话落库：确保会话存在，用户消息先写库（关 app/崩溃也不丢）
    let convId = conversationId;
    if (!convId) {
      try {
        const c = await dbConversations.getOrCreateMainChat(model.id, t("chat.untitledChat"));
        convId = c.id;
        setConversationId(convId);
      } catch {
        // 落库不可用时降级为纯内存，不阻断对话
      }
    }
    let userId: string = crypto.randomUUID();
    if (convId) {
      try {
        userId = (await dbMessages.create({ conversationId: convId, role: "user", content: text })).id;
      } catch {
        // 写库失败降级用内存 id，不阻断
      }
      // 首条消息自动命名会话；后续消息只 bump 排序时间
      if (isFirstMessage) {
        const title = text.slice(0, 40);
        const cid = convId;
        void dbConversations.rename(cid, title).catch(() => {});
        setConversationList((prev) => prev.map((c) => (c.id === cid ? { ...c, title } : c)));
      } else {
        void dbConversations.touch(convId).catch(() => {});
      }
    }

    // 把助手最终/部分回答落库（成功、缓存命中、停止、中断都不丢）
    const persistAssistant = (content: string, modelId: string | null, usage?: { inputTokens: number; outputTokens: number }) => {
      if (!convId || !content) return;
      void dbMessages
        .create({ conversationId: convId, role: "assistant", content, modelId, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 })
        .catch(() => {});
    };

    const userMsg: ChatMessage = { id: userId, role: "user", content: text };
    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "", modelLabel: model.displayName ?? model.name };

    const newMessages = [...messages, userMsg];
    setMessages([...newMessages, assistantMsg]);
    setIsStreaming(true);
    setStreamError(null);
    setSwitchNotice(null);
    setCacheNotice(null);

    const taskRole = classifyMessageComplexity(text);

    // v0.9 阶段7：智能路由开启时先查语义缓存——命中则秒回、0 成本、跳过 LLM
    if (smart) {
      try {
        const hit = await lookupCache(text);
        if (hit) {
          const days = Math.max(0, Math.floor(hit.ageMs / 86_400_000));
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: hit.responseText } : m)),
          );
          persistAssistant(hit.responseText, model.id);
          setCacheNotice(t("chat.cacheHit", { days }));
          setIsStreaming(false);
          return;
        }
      } catch {
        // 缓存查询失败不影响主流程，继续正常调模型
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;

    let primary;
    try {
      primary = toModelEndpoint(model, cred, apiKey);
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : t("chat.constructError"));
      setIsStreaming(false);
      return;
    }

    // 构造回退链：主模型在前，其余已启用模型按「主对话」能力分 + 优先换厂排序接在后面
    // （排序规则见 rankFallbackModels，已带单测）。streamWithFallback 会把同一份对话历史
    // 带给下一个模型，所以限额自动换不丢上下文。
    const chain = [primary];
    for (const cand of rankFallbackModels(model, availableModels, "main_chat")) {
      const fbCred = credentials.find((c) => c.providerId === cand.providerId);
      if (!fbCred) continue;
      // CLI 备用模型无 Key；API 备用模型缺 Key 则跳过
      const fbIsCli = isCliProviderType(cand.provider?.type ?? "");
      let fbKey = "";
      if (!fbIsCli) {
        const k = await getApiKey(fbCred.id);
        if (!k) continue;
        fbKey = k;
      }
      try {
        chain.push(toModelEndpoint(cand, fbCred, fbKey));
      } catch {
        // 备用模型缺 provider 类型等 → 跳过它，不影响主流程
      }
    }

    // 工作文件夹已绑 + 主模型非 CLI → 给模型挂文件工具（读/搜/git-read，写/bash 视权限档）。
    // CLI 模型（claude/codex spawn）自带工具，不挂；构造失败则退化为纯聊天，不阻断。
    let tools: ReturnType<typeof buildAiSdkTools> | undefined;
    let workspacePreamble: string | null = null;
    if (workspacePath && !primaryIsCli) {
      try {
        const includeWrite = permissionMode !== "read";
        tools = buildAiSdkTools(createDefaultToolRegistry({ includeWrite }), {
          workspacePath,
          conversationId: conversationId ?? undefined,
          // auto 档：写操作不弹窗直接放行；confirm 档：每个写操作走 requestConfirm 等用户按确认。
          confirm: permissionMode === "auto" ? async () => true : requestConfirm,
        });
        workspacePreamble = await buildWorkspacePreamble(workspacePath);
      } catch {
        // 构造工具/读自述失败 → 退化为纯聊天
        tools = undefined;
        workspacePreamble = null;
      }
    }

    // 给模型塞一条「当前时间」system 小抄（用户界面不显示）——否则模型答不出"今天几号"，只能瞎猜。
    // 只发一条、放最前面，最省 token；compressHistory 会保留 system 消息不裁掉。
    // 绑了工作文件夹再追一条「项目自述」system（CLAUDE.md/AGENTS.md/README.md），让 AI 一进项目就懂上下文。
    // v0.9 阶段7：智能路由开启时，超长历史先抽取式裁剪省 token（system 与最近消息保留）
    // 注意：编排者折叠回执（kind==="receipt"）绝不进 prompt——它是给用户看的工作记录，不是对话内容。
    let outgoing: ChatMsg[] = [
      { role: "system", content: buildTimePreamble() },
      ...(workspacePreamble ? [{ role: "system" as const, content: workspacePreamble }] : []),
      ...newMessages.filter((m) => m.kind !== "receipt").map((m) => ({ role: m.role, content: m.content })),
    ];
    if (smart) {
      outgoing = compressHistory(outgoing, {
        noticeText: (n) => t("chat.contextTrimmed", { count: n }),
      }).messages;
    }

    let fullContent = "";
    try {
      const result = await streamWithFallback(
        chain,
        outgoing,
        {
          onDelta: (delta) => {
            fullContent += delta;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent } : m))
            );
          },
          onSwitched: (_from, to) => {
            const label = to.displayLabel ?? to.modelName;
            setSwitchNotice(t("chat.switchedTo", { name: label }));
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, switched: true, switchedTo: label, modelLabel: label } : m)),
            );
          },
          onUsage: (usage, usedModel) => {
            const u = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
            setLastUsage(u);
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, usage: u, modelLabel: usedModel.displayLabel ?? usedModel.modelName } : m)),
            );
            persistAssistant(fullContent, usedModel.modelId ?? null, u);
          },
        },
        // role = 这条消息的难度桶，落 UsageEvent 供 v0.9 SmartRouter 按 taskType 滚动统计
        // tools：绑了工作文件夹才传，开启多步工具循环（maxToolSteps 防死循环）
        { signal: controller.signal, role: taskRole, ...(tools ? { tools, maxToolSteps: 12 } : {}) },
      );
      // v0.9 阶段7：成功回答写入语义缓存（isCacheable 内部会过滤时间敏感/代码答案）
      if (smart && fullContent && !controller.signal.aborted) {
        void writeCache(text, fullContent, result.usedModelId, taskRole).catch(() => {});
      }
    } catch (err) {
      // 不丢已经流式出来的半个回答（停止/中断都保留并落库）
      persistAssistant(fullContent, model.id);
      if ((err as Error).name === "AbortError") return;
      setStreamError(classifyLlmError(err, t).userMessage);
      // 不再删用户消息（已落库）；只移除「空的」助手占位，保留有内容的半个回答
      setMessages((prev) => prev.filter((m) => m.id !== assistantId || m.content !== ""));
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }

    // 后台滚动编排：本轮答完后用便宜模型重判节点 + 按节点定模型。非阻塞、失败静默、不进 prompt。
    if (convId && fullContent && !controller.signal.aborted) {
      void runBackgroundOrchestration(convId, [...newMessages, { ...assistantMsg, content: fullContent }]);
    }
  }

  // 用编排结果造一条折叠回执（首次规划 / 进入新节点 / 同节点换模型 三种文案）
  function buildReceipt(
    change: OrchestrationChange,
    next: OrchestrationState,
    prev: OrchestrationState | null,
    reason: string,
  ): ReceiptContent | null {
    const node = change.node;
    if (!node) return null;
    const nameOf = (id: string | null) =>
      (id ? availableModels.find((m) => m.id === id)?.displayName ?? availableModels.find((m) => m.id === id)?.name : null) ?? null;
    const nodeLabel = t(`chat.orchestrator.nodeKinds.${node.kind}`);
    const modelName = nameOf(node.modelId) ?? t("chat.orchestrator.receiptNoModel");
    let summary: string;
    if (!prev) {
      summary = t("chat.orchestrator.receiptPlanned", { count: next.nodes.length, node: nodeLabel, model: modelName });
    } else if (change.nodeChanged) {
      summary = t("chat.orchestrator.receiptEntered", { node: nodeLabel, model: modelName });
    } else {
      summary = t("chat.orchestrator.receiptSwitched", { node: nodeLabel, model: modelName });
    }
    const nodesList = next.nodes
      .map((n) => {
        const mk = nameOf(n.modelId);
        const mark = n.id === next.currentNodeId ? "▸ " : "· ";
        return `${mark}${t(`chat.orchestrator.nodeKinds.${n.kind}`)}：${n.title}${mk ? ` — ${mk}` : ""}`;
      })
      .join("\n");
    const detail = `${t("chat.orchestrator.receiptReason", { reason })}\n\n${t("chat.orchestrator.detailNodes")}：\n${nodesList}`;
    return { summary, detail };
  }

  // 后台编排：选最省的非 CLI 模型跑 planNodes → 定模型 → 落库 + 自动切 + 写回执。全程兜底，绝不影响主对话。
  async function runBackgroundOrchestration(convId: string, msgs: ChatMessage[]) {
    try {
      // CLI 模型走 spawn，不能用 generateObject；编排只能用 API 直连模型
      const apiModels = availableModels.filter((m) => !isCliProviderType(m.provider?.type ?? ""));
      const orchModel = pickOrchestratorModel(apiModels);
      if (!orchModel || !orchModel.provider) return;
      const cred = credentials.find((c) => c.providerId === orchModel.providerId);
      if (!cred) return;
      const key = (await getApiKey(cred.id)) ?? "";
      if (!key) return;
      const lm = getLanguageModel(orchModel.provider.type, orchModel.name, key, cred.baseUrl);

      const history: OrchestrationTurn[] = msgs
        .filter((m) => m.kind !== "receipt" && m.content)
        .map((m) => ({ role: m.role, content: m.content }));

      const prev = orchestrationRef.current;
      const plan = await planNodes(lm, history, prev);
      const next = resolveOrchestration(plan, availableModels, prev);
      const change = diffOrchestration(prev, next);

      // 落库总用正确的 convId（即使用户已切走也要存对）
      void dbConversations.saveOrchestration(convId, serializeOrchestration(next)).catch(() => {});
      // 用户已切到别的会话 → 不要把本会话的状态/回执塞进当前 UI（切回来会从库加载）
      if (conversationIdRef.current !== convId) return;

      applyOrchestration(next);

      if (change.nodeChanged || change.modelChanged) {
        // 自动切：把当前节点的模型设为选中（UI 跟上），下一轮 handleSend 就用它
        if (change.node?.modelId && availableModels.some((m) => m.id === change.node!.modelId)) {
          setSelectedModelId(change.node.modelId);
        }
        const receipt = buildReceipt(change, next, prev, plan.reason);
        if (receipt) {
          let noteId: string = crypto.randomUUID();
          try {
            noteId = (await dbMessages.create({ conversationId: convId, role: "note", content: JSON.stringify(receipt) })).id;
          } catch {
            // 回执落库失败仍在内存里展示
          }
          setMessages((prevMsgs) => [...prevMsgs, { id: noteId, role: "assistant", content: "", kind: "receipt", receipt }]);
        }
      }
    } catch {
      // 编排失败静默——绝不影响主对话
    }
  }

  // 停止 = 中止当前回复 + 清空排队（用户主动喊停，不该让后面排的继续跑）
  function handleStop() {
    abortRef.current?.abort();
    setPendingQueue([]);
  }

  // 串行排空队列：不忙（没在流式）时取队首发送，发完自动取下一条。
  // drainingRef 守住"取出→handleSend 真正置 isStreaming=true"之间的空窗，防并发重入。
  useEffect(() => {
    if (drainingRef.current || isStreaming || pendingQueue.length === 0) return;
    const next = pendingQueue[0]!;
    drainingRef.current = true;
    setPendingQueue((q) => q.slice(1));
    void handleSend(next).finally(() => {
      drainingRef.current = false;
    });
    // handleSend 不是稳定引用，但每次都读当时最新 state，故意只依赖触发条件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, pendingQueue]);

  // 隐式信号采集（改进-1 Step B）：用户在已有对话里手动换到能力分更高的模型，
  // 说明上一个模型这次没让他满意（路由派轻了）→ 给上个模型记一条 switched_up 负反馈，喂回评分。
  function handleModelChange(newId: string) {
    const oldId = selectedModelId;
    setSelectedModelId(newId);

    // 用户手动接管：把这个模型钉到当前节点，编排后续不再自动覆盖它。
    const state = orchestrationRef.current;
    if (state && state.currentNodeId) {
      const pinned = pinModelToCurrentNode(state, newId);
      applyOrchestration(pinned);
      if (conversationId) void dbConversations.saveOrchestration(conversationId, serializeOrchestration(pinned)).catch(() => {});
    }

    if (!oldId || oldId === newId || messages.length === 0) return;
    const oldM = availableModels.find((m) => m.id === oldId);
    const newM = availableModels.find((m) => m.id === newId);
    if (oldM && newM && scoreModelForRole(newM, "main_chat") > scoreModelForRole(oldM, "main_chat")) {
      void applyOutcomeForLatest(oldId, "switched_up");
    }
  }

  // 从节点地图给「任意节点」（含还没轮到的）主动指定模型：钉住该节点，编排后续不自动覆盖。
  // 不走 switched_up——这是用户对某节点的明确指派，不是"嫌弃当前回答"。
  function handleNodeModelChange(nodeId: string, modelId: string) {
    const state = orchestrationRef.current;
    if (!state) return;
    const updated = pinModelToNode(state, nodeId, modelId);
    applyOrchestration(updated);
    if (conversationId) void dbConversations.saveOrchestration(conversationId, serializeOrchestration(updated)).catch(() => {});
    // 改的是当前节点 → 顶部选择器也跟上，下一轮就用它
    if (nodeId === state.currentNodeId) setSelectedModelId(modelId);
  }

  async function handleSmartPick() {
    const title = t("chat.smartPickResult.title");
    // 没有模型可推荐：明确告知去配置
    if (availableModels.length === 0) {
      await alert({ title, description: t("chat.smartPickResult.noModels") });
      return;
    }
    const text = inputRef.current?.value.trim() ?? "";
    const currentId = selectedModelId;

    // 智能路由开启 + 有输入：用 SmartRouter 按真实表现评分选模型，并展示决策理由
    if (isSmartRoutingEnabled() && text) {
      try {
        const routed = await routeMessage(text, availableModels);
        if (routed) {
          const name = routed.model.displayName ?? routed.model.name;
          const reason = routed.decisionLog.reasons[0] ?? "";
          setSelectedModelId(routed.model.id);
          setSwitchNotice(reason || null);
          await alert({
            title,
            description:
              (routed.model.id === currentId
                ? t("chat.smartPickResult.alreadyBest", { name })
                : t("chat.smartPickResult.switched", { name })) +
              (reason ? `\n\n${t("chat.smartPickResult.reasonLabel")}${reason}` : ""),
          });
          return;
        }
      } catch {
        // 路由失败回落 v1 规则路由
      }
    }

    // 兜底：v1 规则按角色挑能力分最高
    const best = pickBestModelForRole("main_chat", availableModels);
    if (!best) {
      await alert({ title, description: t("chat.smartPickResult.noPick") });
      return;
    }
    const name = best.displayName ?? best.name;
    // 输入框为空时，附带一句"先输入问题更精准"的提示
    const hint = text ? "" : `\n\n${t("chat.smartPickResult.emptyHint")}`;
    if (best.id === currentId) {
      await alert({ title, description: t("chat.smartPickResult.alreadyBest", { name }) + hint });
      return;
    }
    setSelectedModelId(best.id);
    await alert({ title, description: t("chat.smartPickResult.switchedRule", { name }) + hint });
  }

  function handleFormSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const text = String(formData.get("input") ?? "").trim();
    if (!text) return;
    // 一律入队，由 drain effect 串行处理：空闲时立刻发，回复中则排队，回完自动接着发。
    setPendingQueue((q) => [...q, text]);
    (e.currentTarget as HTMLFormElement).reset();
    setShowDebateHint(false);
  }

  const selectedModel = availableModels.find(m => m.id === selectedModelId);

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <Alert variant="destructive" className="max-w-md bg-red-500/10 border-red-500/20 backdrop-blur-xl">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full">
      <div className="relative flex flex-col h-full flex-1 min-w-0 rounded-3xl overflow-hidden glass">
      {/* 写操作确认弹窗：confirm 档下，AI 写文件/跑命令前弹出，给用户看 diff 后再放行 */}
      {pendingConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6">
          <div className="glass border border-white/15 rounded-2xl max-w-2xl w-full max-h-[80%] flex flex-col shadow-2xl">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-white/10">
              <ShieldAlert className="w-4 h-4 text-amber-500" />
              <span className="font-bold text-sm">{t("chat.tools.confirmTitle")}</span>
              <span className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 uppercase">{pendingConfirm.toolName}</span>
            </div>
            <div className="px-5 py-3 text-xs font-bold text-muted-foreground">{pendingConfirm.summary}</div>
            {pendingConfirm.diff && (
              <pre className="flex-1 overflow-auto mx-5 mb-3 p-3 rounded-xl bg-black/30 text-[11px] leading-relaxed font-mono custom-scrollbar">
                {pendingConfirm.diff.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith("+") ? "text-emerald-400"
                        : line.startsWith("-") ? "text-red-400"
                        : "text-muted-foreground/70"
                    }
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            )}
            <div className="flex justify-end gap-3 px-5 py-4 border-t border-white/10">
              <Button variant="outline" size="sm" className="rounded-xl" onClick={() => resolveConfirm(false)}>
                {t("chat.tools.reject")}
              </Button>
              <Button size="sm" className="rounded-xl bg-emerald-600 hover:bg-emerald-700" onClick={() => resolveConfirm(true)}>
                {t("chat.tools.approve")}
              </Button>
            </div>
          </div>
        </div>
      )}
      {/* 顶部控制栏 - Premium Glass Effect */}
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/10 glass z-10">
        <div className="flex items-center gap-3">
          <ConversationSwitcher
            conversations={conversationList}
            activeId={conversationId}
            disabled={isStreaming}
            onSwitch={(id) => void switchConversation(id)}
            onNew={() => void handleNewChat()}
            onDelete={(id) => void handleDeleteConversation(id)}
            onRename={(id, title) => void handleRenameConversation(id, title)}
          />
          <div className="h-5 w-px bg-white/10 shrink-0" />
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-primary to-accent rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
            <div className="relative flex items-center gap-2 px-3 py-1.5 rounded-xl">
              <Cpu className="w-4 h-4 text-primary shrink-0" />
              <Select value={selectedModelId} onValueChange={handleModelChange}>
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
            onClick={() => void handleSmartPick()}
            className="h-9 px-3 text-xs font-medium hover:bg-primary/10 hover:text-primary transition-all rounded-xl gap-2"
          >
            <div className="p-1 bg-primary/10 rounded-lg group-hover:scale-110 transition-transform">
              <Sparkles className="w-3.5 h-3.5 text-primary" />
            </div>
            {t("chat.smartPick")}
          </Button>

          <div className="h-5 w-px bg-white/10 shrink-0" />

          {/* 工作文件夹 + 工具权限三档（产品真北：让主对话能在本地真干活） */}
          {workspacePath ? (
            <div className="flex items-center gap-2">
              <div
                className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-xl bg-emerald-500/10 text-emerald-600 max-w-[160px]"
                title={workspacePath}
              >
                <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                <span className="text-xs font-bold truncate">{workspacePath.split("/").filter(Boolean).pop()}</span>
                <button
                  type="button"
                  onClick={() => void clearWorkspace()}
                  disabled={isStreaming}
                  title={t("chat.workspace.clear")}
                  className="shrink-0 p-0.5 rounded-md hover:bg-emerald-500/20 disabled:opacity-40"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="flex items-center rounded-xl bg-muted/40 p-0.5">
                {([["read", Lock], ["confirm", ShieldCheck], ["auto", Zap]] as const).map(([mode, Icon]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setPermissionMode(mode)}
                    title={t(`chat.permission.${mode}Hint`)}
                    className={cn(
                      "px-2 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1 transition-colors",
                      permissionMode === mode ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="w-3 h-3" />
                    {t(`chat.permission.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void chooseWorkspace()}
              disabled={isStreaming}
              className="h-9 px-3 text-xs font-medium hover:bg-primary/10 hover:text-primary transition-all rounded-xl gap-2"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              {t("chat.workspace.choose")}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-4">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => setPanelOpen((v) => !v)}
            title={t("chat.workPanel.title")}
            className={cn("h-9 w-9 rounded-xl", panelOpen ? "bg-primary/10 text-primary" : "hover:bg-white/10")}
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
        </div>
      </header>

      {/* 对话列表容器 */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scroll-smooth custom-scrollbar"
      >
        {availableModels.length === 0 ? (
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
          <div className="pb-32">
            {messages.map((m) => {
              if (m.kind === "receipt" && m.receipt) {
                return <ReceiptItem key={m.id} receipt={m.receipt} />;
              }
              const isLastAssistant = m.role === "assistant" && m === messages[messages.length - 1];
              const streamingThis = isLastAssistant && isStreaming;
              return (
                <MessageItem
                  key={m.id}
                  role={m.role}
                  text={m.content}
                  isStreaming={streamingThis}
                  elapsedLabel={streamingThis ? formatElapsed(streamElapsedMs) : undefined}
                />
              );
            })}
            {/* 排队中的消息：模型回复时用户继续发的句子，淡显 + "排队中"标签，让用户看到没丢、在等着处理 */}
            {isStreaming && pendingQueue.map((q, i) => (
              <div key={`pending-${i}`} className="flex gap-4 px-6 py-4 opacity-50">
                <div className="flex max-w-4xl mx-auto w-full gap-5">
                  <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-primary to-blue-600 text-primary-foreground flex items-center justify-center shrink-0 rotate-[-6deg]">
                    <User className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-amber-500/70">{t("chat.queued")}</span>
                    <div className="text-sm text-foreground/80 whitespace-pre-wrap break-words">{q}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {streamError && (
          <div className="px-6 py-4">
            <Alert variant="destructive" className="bg-red-500/10 border-red-500/20">
              <AlertDescription className="text-xs font-medium">{streamError}</AlertDescription>
            </Alert>
          </div>
        )}
      </div>

      {/* 输入框区域 - Floating Command Center */}
      <div className="absolute bottom-8 left-8 right-8 z-20 pointer-events-none">
        {onOpenDebate && showDebateHint && !isStreaming && (
          <div className="max-w-4xl mx-auto mb-2.5 pointer-events-auto">
            <div className="glass rounded-2xl border border-primary/30 shadow-lg px-4 py-2.5 flex items-center gap-3">
              <Swords className="w-4 h-4 text-primary shrink-0" />
              <span className="text-xs font-medium text-muted-foreground flex-1">{t("chat.suggestDebate")}</span>
              <Button
                type="button"
                size="sm"
                onClick={() => onOpenDebate(inputRef.current?.value.trim() ?? "")}
                className="rounded-xl h-8 px-4 text-xs font-bold shrink-0"
              >
                {t("chat.suggestDebateBtn")}
              </Button>
            </div>
          </div>
        )}
        <form
          onSubmit={handleFormSubmit}
          className="max-w-4xl mx-auto glass rounded-[2.5rem] border border-white/20 shadow-2xl p-2.5 flex gap-3 pointer-events-auto group transition-all duration-500 hover:border-primary/30"
        >
          <div className="flex-1 relative">
            <input
              ref={inputRef}
              name="input"
              placeholder={
                isStreaming
                  ? t("chat.inputDraftHint")
                  : selectedModel
                  ? t("chat.inputPlaceholder", { name: selectedModel.displayName || selectedModel.name })
                  : t("chat.inputPlaceholderFallback")
              }
              autoComplete="off"
              onChange={(e) => setShowDebateHint(shouldSuggestDebate(e.target.value))}
              className="w-full bg-transparent border-none outline-none focus:outline-none focus:ring-0 text-sm px-6 py-4 placeholder:text-muted-foreground/40 font-medium"
            />
          </div>
          <div className="flex items-center pr-1.5">
            {isStreaming ? (
              <Button
                type="button"
                variant="destructive"
                onClick={handleStop}
                className="w-12 h-12 rounded-[1.5rem] animate-pulse shadow-lg shadow-red-500/20"
              >
                <Square className="w-5 h-5 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                className="w-12 h-12 rounded-[1.5rem] bg-primary shadow-lg shadow-primary/30 hover:scale-110 active:scale-95 transition-all duration-300 group-hover:rotate-[-5deg]"
              >
                <Send className="w-5 h-5" />
              </Button>
            )}
          </div>
        </form>
        <p className="text-[10px] text-center mt-4 text-muted-foreground/30 font-bold uppercase tracking-[0.3em] select-none">
          {t("chat.footer", { version: "v0.7.3" })}
        </p>
      </div>
      </div>

      {/* 右侧工作面板：多模型工作可视化（默认收起，不影响现有布局；左侧分隔条可拖拽放大） */}
      {panelOpen && (
        <>
        <ResizeHandle onMouseDown={workPanel.onMouseDown} />
        <aside style={{ width: workPanel.width }} className="shrink-0 glass h-full flex flex-col rounded-3xl overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between border-b border-white/10 shrink-0">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              <span className="text-xs font-black uppercase tracking-[0.2em]">{t("chat.workPanel.title")}</span>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => setPanelOpen(false)}
              title={t("chat.workPanel.close")}
              className="h-7 w-7 rounded-lg hover:bg-white/10"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
            {/* 当前活动：直观告诉用户"模型此刻在做什么"——思考中/回复中/空闲 + 模型 + 计时。
                这才是工作面板的本义（看模型在干活），而不只是 token 账单。 */}
            <div className={cn("glass rounded-2xl p-4 border", isStreaming ? "border-primary/30" : "border-white/5")}>
              <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 mb-2">
                {t("chat.workPanel.currentActivity")}
              </div>
              {isStreaming ? (
                <div className="flex items-center gap-2.5">
                  <ThinkingLogo className="w-5 h-5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-primary">
                      {t("chat.replying")} · {formatElapsed(streamElapsedMs)}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60 truncate">{selectedModel?.displayName ?? selectedModel?.name ?? "—"}</div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-400/70 shrink-0" />
                  <span className="text-xs font-medium text-muted-foreground">{t("chat.workPanel.idle")}</span>
                </div>
              )}
            </div>
            {/* 编排者节点地图：已规划节点 + 当前高亮 + 每节点绑定模型（看得见、可接管） */}
            {orchestration && orchestration.nodes.length > 0 && (
              <div className="glass rounded-2xl p-4 border border-white/5 space-y-2.5">
                <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
                  {t("chat.orchestrator.panelTitle")}
                </div>
                <div className="space-y-1.5">
                  {orchestration.nodes.map((n) => {
                    const isCurrent = n.id === orchestration.currentNodeId;
                    const mm = n.modelId ? availableModels.find((m) => m.id === n.modelId) : undefined;
                    const modelName = mm?.displayName ?? mm?.name ?? null;
                    return (
                      <div
                        key={n.id}
                        className={cn(
                          "rounded-xl px-3 py-2 border",
                          isCurrent ? "bg-primary/10 border-primary/20" : "bg-white/[0.02] border-white/5",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "w-1.5 h-1.5 rounded-full shrink-0",
                              n.status === "done"
                                ? "bg-emerald-400"
                                : n.status === "active"
                                ? "bg-primary animate-pulse"
                                : "bg-muted-foreground/30",
                            )}
                          />
                          <span className={cn("text-xs font-bold", isCurrent ? "text-primary" : "text-foreground/80")}>
                            {t(`chat.orchestrator.nodeKinds.${n.kind}`)}
                          </span>
                          {isCurrent && (
                            <span className="ml-auto text-[8px] font-black uppercase px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
                              {t("chat.orchestrator.currentBadge")}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground/70 truncate pl-3.5">{n.title}</div>
                        {/* 每个节点可主动改模型（含还没轮到的）：选了就钉住，编排不再自动覆盖 */}
                        <div className="mt-1 flex items-center gap-1 pl-3.5">
                          <Cpu className="w-2.5 h-2.5 shrink-0 text-muted-foreground/50" />
                          <Select value={n.modelId ?? ""} onValueChange={(v) => handleNodeModelChange(n.id, v)} disabled={isStreaming}>
                            <SelectTrigger className="h-6 border-0 bg-transparent shadow-none focus-visible:ring-0 px-1 text-[10px] text-muted-foreground/60 hover:text-foreground gap-1 [&>svg]:w-2.5 [&>svg]:h-2.5">
                              <SelectValue placeholder={t("chat.orchestrator.receiptNoModel")}>{modelName ?? undefined}</SelectValue>
                            </SelectTrigger>
                            <SelectContent position="popper" side="bottom" align="start" avoidCollisions={false}>
                              {availableModels.map((m) => (
                                <SelectItem key={m.id} value={m.id} className="text-xs focus:bg-primary focus:text-primary-foreground">
                                  {m.displayName ?? m.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {n.pinned && <Pin className="w-2.5 h-2.5 shrink-0 text-amber-400/70" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {(() => {
              const turns = messages.filter((m) => m.role === "assistant" && (m.modelLabel || m.usage));
              if (turns.length === 0) {
                return (
                  <div className="text-[11px] text-muted-foreground/40 text-center py-12 uppercase tracking-widest">
                    {t("chat.workPanel.empty")}
                  </div>
                );
              }
              const totalIn = turns.reduce((s, m) => s + (m.usage?.inputTokens ?? 0), 0);
              const totalOut = turns.reduce((s, m) => s + (m.usage?.outputTokens ?? 0), 0);
              return (
                <>
                  <div className="glass rounded-2xl p-4 border border-white/5">
                    <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 mb-2">
                      {t("chat.workPanel.sessionTotal")}
                    </div>
                    <div className="flex gap-4 font-mono text-xs">
                      <span className="text-blue-400">{t("chat.workPanel.inTokens")} {totalIn.toLocaleString()}</span>
                      <span className="text-orange-400">{t("chat.workPanel.outTokens")} {totalOut.toLocaleString()}</span>
                    </div>
                  </div>
                  {turns.map((m, i) => (
                    <div key={m.id} className="glass rounded-2xl p-4 border border-white/5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/40">
                          {t("chat.workPanel.turnLabel", { n: i + 1 })}
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
                        <span className="truncate">{m.modelLabel ?? "—"}</span>
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
                  ))}
                </>
              );
            })()}
          </div>
        </aside>
        </>
      )}
    </div>
  );
}
