// ChatPage - 重构为 "Cosmic Cyber" 视觉风格
import { memo, useEffect, useRef, useState } from "react";
import { Bot, Send, Square, User, Zap, Sparkles, Cpu, PanelRight, X, Activity, Swords, Plus, Trash2, MessageSquare, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePanelResize, ResizeHandle } from "@/components/ui/resize-handle";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { type ModelListItem, type CredentialListItem } from "@/lib/api";
import { models as dbModels, apiCredentials as dbCredentials, conversations as dbConversations, messages as dbMessages, type Conversation, type DbMessage } from "@/lib/db";
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
import { classifyLlmError } from "@/lib/llm/error-classifier";
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
}

type ChatUsage = StreamUsage;

/** 把落库的消息映射回 UI 的 ChatMessage（恢复历史 / 切换会话复用） */
function dbMessagesToChat(hist: DbMessage[], models: ModelListItem[]): ChatMessage[] {
  return hist
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      modelLabel: (m.modelId ? models.find((x) => x.id === m.modelId)?.displayName : undefined) ?? undefined,
      usage: m.outputTokens > 0 ? { inputTokens: m.inputTokens, outputTokens: m.outputTokens } : undefined,
    }));
}

const MessageItem = memo(function MessageItem({
  role,
  text,
  isStreaming,
}: {
  role: "user" | "assistant";
  text: string;
  isStreaming: boolean;
}) {
  const { t } = useTranslation();
  const isAssistant = role === "assistant";

  return (
    <div
      className={cn(
        "group flex gap-4 px-6 py-8 transition-colors duration-500",
        isAssistant ? "bg-primary/5 border-y border-primary/5" : "bg-transparent",
        "animate-in fade-in slide-in-from-bottom-2 duration-700"
      )}
    >
      <div className="flex max-w-4xl mx-auto w-full gap-5">
        <div
          className={cn(
            "w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 shadow-lg transition-transform group-hover:scale-110 duration-300",
            !isAssistant
              ? "bg-gradient-to-br from-primary to-blue-600 text-primary-foreground rotate-[-6deg]"
              : "bg-white dark:bg-zinc-800 rotate-[6deg] border border-primary/10 overflow-hidden",
          )}
        >
          {!isAssistant ? (
            <User className="w-5 h-5" />
          ) : (
            <img src={cosmgridLogo} className={cn("w-7 h-7", isStreaming && "animate-pulse-slow")} alt="Bot" />
          )}
        </div>
        <div className="flex-1 space-y-2 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
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
            {isStreaming && isAssistant && (
              <span className="inline-block w-2 h-5 ml-1 bg-primary/40 animate-pulse rounded-sm align-middle" />
            )}
          </div>
        </div>
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
}: {
  conversations: Conversation[];
  activeId: string | null;
  disabled: boolean;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
                  onSwitch(c.id);
                  setOpen(false);
                }}
                className={cn(
                  "group flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer text-sm transition-colors",
                  c.id === activeId ? "bg-primary/10 text-primary font-medium" : "hover:bg-white/5 text-muted-foreground",
                )}
              >
                <MessageSquare className="w-3.5 h-3.5 shrink-0 opacity-70" />
                <span className="flex-1 truncate">{c.title || t("chat.untitledChat")}</span>
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
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface ChatPageProps {
  /** 用户在输入框写下"多方案权衡"类问题时，点"开对弈"会带着这条话题跳到对弈页 */
  onOpenDebate?: (topic: string) => void;
}

export function ChatPage({ onOpenDebate }: ChatPageProps = {}) {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const [availableModels, setAvailableModels] = useState<ModelListItem[]>([]);
  const [credentials, setCredentials] = useState<CredentialListItem[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationList, setConversationList] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<ChatUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [showDebateHint, setShowDebateHint] = useState(false);
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

  useEffect(() => {
    void (async () => {
      try {
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
        if (ml.length > 0) setSelectedModelId(ml[0]!.id);

        // 主对话多会话：列出全部主对话，没有就建一条，恢复最近一条的历史（关 app 不丢上下文）
        let list = await dbConversations.listMainChats();
        if (list.length === 0) {
          await dbConversations.getOrCreateMainChat(ml[0]?.id ?? null, t("chat.untitledChat"));
          list = await dbConversations.listMainChats();
        }
        setConversationList(list);
        const active = list[0]!;
        setConversationId(active.id);
        const hist = await dbMessages.listByConversation(active.id);
        setMessages(dbMessagesToChat(hist, ml));
        setLoadError(null);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : t("chat.loadError"));
      }
    })();
  }, []);

  async function handleNewChat() {
    if (isStreaming) return;
    try {
      const conv = await dbConversations.create({ title: t("chat.untitledChat"), defaultModelId: selectedModelId || null, projectId: null });
      setConversationList((prev) => [conv, ...prev]);
      setConversationId(conv.id);
      setMessages([]);
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
    setStreamError(null);
    setSwitchNotice(null);
    setCacheNotice(null);
    try {
      const hist = await dbMessages.listByConversation(id);
      setMessages(dbMessagesToChat(hist, availableModels));
    } catch {
      setMessages([]);
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
      setMessages([]);
      return;
    }
    setConversationList(remaining);
    if (id === conversationId) {
      const next = remaining[0]!;
      setConversationId(next.id);
      try {
        const hist = await dbMessages.listByConversation(next.id);
        setMessages(dbMessagesToChat(hist, availableModels));
      } catch {
        setMessages([]);
      }
    }
  }

  async function handleSend(text: string) {
    const model = availableModels.find((m) => m.id === selectedModelId);
    if (!model || isStreaming) return;

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

    // v0.9 阶段7：智能路由开启时，超长历史先抽取式裁剪省 token（system 与最近消息保留）
    let outgoing: ChatMsg[] = newMessages.map((m) => ({ role: m.role, content: m.content }));
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
        { signal: controller.signal, role: taskRole },
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
  }

  function handleStop() { abortRef.current?.abort(); }

  // 隐式信号采集（改进-1 Step B）：用户在已有对话里手动换到能力分更高的模型，
  // 说明上一个模型这次没让他满意（路由派轻了）→ 给上个模型记一条 switched_up 负反馈，喂回评分。
  function handleModelChange(newId: string) {
    const oldId = selectedModelId;
    setSelectedModelId(newId);
    if (!oldId || oldId === newId || messages.length === 0) return;
    const oldM = availableModels.find((m) => m.id === oldId);
    const newM = availableModels.find((m) => m.id === newId);
    if (oldM && newM && scoreModelForRole(newM, "main_chat") > scoreModelForRole(oldM, "main_chat")) {
      void applyOutcomeForLatest(oldId, "switched_up");
    }
  }

  async function handleSmartPick() {
    if (availableModels.length === 0) return;
    const text = inputRef.current?.value.trim() ?? "";

    // 智能路由开启 + 有输入：用 SmartRouter 按真实表现评分选模型，并展示决策理由
    if (isSmartRoutingEnabled() && text) {
      try {
        const routed = await routeMessage(text, availableModels);
        if (routed) {
          setSelectedModelId(routed.model.id);
          setSwitchNotice(routed.decisionLog.reasons[0] ?? null);
          return;
        }
      } catch {
        // 路由失败回落 v1
      }
    }

    // 兜底：v1 规则按角色挑能力分最高
    const best = pickBestModelForRole("main_chat", availableModels);
    if (best) setSelectedModelId(best.id);
  }

  function handleFormSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const text = String(formData.get("input") ?? "").trim();
    if (!text || isStreaming) return;
    void handleSend(text);
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
               <img src={cosmgridLogo} className="w-20 h-20 opacity-20 relative" alt="Empty" />
             </div>
             <p className="text-sm font-bold uppercase tracking-[0.4em] text-muted-foreground/30">{t("chat.ready")}</p>
          </div>
        ) : (
          <div className="pb-32">
            {messages.map((m) => {
              const isLastAssistant = m.role === "assistant" && m === messages[messages.length - 1];
              return (
                <MessageItem
                  key={m.id}
                  role={m.role}
                  text={m.content}
                  isStreaming={isLastAssistant && isStreaming}
                />
              );
            })}
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
              placeholder={selectedModel ? t("chat.inputPlaceholder", { name: selectedModel.displayName || selectedModel.name }) : t("chat.inputPlaceholderFallback")}
              disabled={isStreaming}
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
