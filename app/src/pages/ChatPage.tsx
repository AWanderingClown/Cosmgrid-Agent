// ChatPage - 重构为 "Cosmic Cyber" 视觉风格
import { memo, useEffect, useRef, useState } from "react";
import { Bot, Send, Square, User, Zap, Sparkles, Cpu, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { type ModelListItem, type CredentialListItem } from "@/lib/api";
import { models as dbModels, apiCredentials as dbCredentials } from "@/lib/db";
import { getApiKey } from "@/lib/keystore";
import { streamWithFallback, toModelEndpoint, type StreamUsage } from "@/lib/llm/chat-fallback";
import { pickBestModelForRole } from "@/lib/llm/model-capabilities";
import cosmgridLogo from "@/assets/cosmgrid-logo.svg";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

type ChatUsage = StreamUsage;

const MessageItem = memo(function MessageItem({
  role,
  text,
  isStreaming,
}: {
  role: "user" | "assistant";
  text: string;
  isStreaming: boolean;
}) {
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
              {isAssistant ? "CosmGrid 助手" : "授权用户"}
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

export function ChatPage() {
  const [availableModels, setAvailableModels] = useState<ModelListItem[]>([]);
  const [credentials, setCredentials] = useState<CredentialListItem[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<ChatUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
        setLoadError(null);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "加载失败");
      }
    })();
  }, []);

  async function handleSend(text: string) {
    const model = availableModels.find((m) => m.id === selectedModelId);
    if (!model || isStreaming) return;

    const cred = credentials.find((c) => c.providerId === model.providerId);
    if (!cred) {
      setStreamError("未找到 API 凭证");
      return;
    }

    const apiKey = await getApiKey(cred.id);
    if (!apiKey) {
      setStreamError("API Key 缺失");
      return;
    }

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "" };

    const newMessages = [...messages, userMsg];
    setMessages([...newMessages, assistantMsg]);
    setIsStreaming(true);
    setStreamError(null);
    setSwitchNotice(null);

    const controller = new AbortController();
    abortRef.current = controller;

    let primary;
    try {
      primary = toModelEndpoint(model, cred, apiKey);
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : "构造失败");
      setIsStreaming(false);
      return;
    }

    const chain = [primary];
    let fullContent = "";
    try {
      await streamWithFallback(
        chain,
        newMessages.map((m) => ({ role: m.role, content: m.content })),
        {
          onDelta: (delta) => {
            fullContent += delta;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent } : m))
            );
          },
          onSwitched: (_from, to) => {
            setSwitchNotice(`切换至 ${to.displayLabel ?? to.modelName}`);
          },
          onUsage: (usage) => {
            setLastUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
          },
        },
        { signal: controller.signal },
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setStreamError(err instanceof Error ? err.message : "请求中断");
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  function handleStop() { abortRef.current?.abort(); }

  function handleSmartPick() {
    if (availableModels.length === 0) return;
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
    <div className="flex flex-col h-full bg-background/30 backdrop-blur-sm">
      {/* 顶部控制栏 - Premium Glass Effect */}
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/10 glass z-10">
        <div className="flex items-center gap-4">
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-primary to-accent rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
            <div className="relative flex items-center gap-2 px-3 py-1.5 bg-background border border-white/10 rounded-xl cursor-pointer">
              <Cpu className="w-4 h-4 text-primary" />
              <select
                value={selectedModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                className="text-xs font-bold appearance-none bg-transparent focus:outline-none pr-6 cursor-pointer"
              >
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id} className="bg-background text-foreground">
                    {m.displayName ?? m.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 w-3 h-3 text-muted-foreground pointer-events-none" />
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleSmartPick}
            className="h-9 px-3 text-xs font-medium hover:bg-primary/10 hover:text-primary transition-all rounded-xl gap-2"
          >
            <div className="p-1 bg-primary/10 rounded-lg group-hover:scale-110 transition-transform">
              <Sparkles className="w-3.5 h-3.5 text-primary" />
            </div>
            智能推荐
          </Button>
        </div>

        <div className="flex items-center gap-4">
          {lastUsage && (
            <div className="hidden md:flex items-center gap-3 px-3 py-1 bg-muted/30 rounded-full border border-white/5">
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">用量</span>
              <div className="flex gap-2">
                <span className="text-[10px] font-mono text-blue-400">输入:{lastUsage.inputTokens}</span>
                <span className="text-[10px] font-mono text-orange-400">输出:{lastUsage.outputTokens}</span>
              </div>
            </div>
          )}
          {switchNotice && (
            <div className="flex items-center gap-2 px-3 py-1 bg-amber-500/10 text-amber-500 rounded-full border border-amber-500/20 animate-pulse">
              <Zap className="w-3 h-3" />
              <span className="text-[10px] font-bold uppercase">{switchNotice}</span>
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
              <h2 className="text-2xl font-bold tracking-tight">等待初始化</h2>
              <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                请先前往「模型供应商」页面，建立你的 AI 神经连接。
              </p>
            </div>
            <Button variant="outline" className="rounded-2xl border-primary/20 hover:bg-primary/5">
              前往配置
            </Button>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full animate-in fade-in duration-1000">
             <div className="relative mb-8">
               <div className="absolute -inset-4 bg-primary/20 blur-3xl opacity-50" />
               <img src={cosmgridLogo} className="w-20 h-20 opacity-20 relative" alt="Empty" />
             </div>
             <p className="text-sm font-bold uppercase tracking-[0.4em] text-muted-foreground/30">准备就绪</p>
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
        <form
          onSubmit={handleFormSubmit}
          className="max-w-4xl mx-auto glass rounded-[2.5rem] border border-white/20 shadow-2xl p-2.5 flex gap-3 pointer-events-auto group transition-all duration-500 hover:border-primary/30"
        >
          <div className="flex-1 relative">
            <input
              name="input"
              placeholder={selectedModel ? `使用 ${selectedModel.displayName || selectedModel.name} 进行对话...` : "输入消息..."}
              disabled={isStreaming}
              autoComplete="off"
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
          安全连接 • v0.7.3 • 由 CosmGrid 驱动
        </p>
      </div>
    </div>
  );
}
