// ChatPage - 对话页
// v0.3：useChat + /api/chat/stream → 直接用 streamText from 'ai'（不经中间 HTTP server）
// v0.4.1：改用 streamWithFallback（数组式 fallback 链 + 内置 recordUsageEvent）
import { memo, useEffect, useRef, useState } from "react";
import { Bot, Send, Square, User, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { type ModelListItem, type CredentialListItem } from "@/lib/api";
import { models as dbModels, apiCredentials as dbCredentials } from "@/lib/db";
import { getApiKey } from "@/lib/keystore";
import { streamWithFallback, toModelEndpoint, type StreamUsage } from "@/lib/llm/chat-fallback";

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
  return (
    <div
      className={cn(
        "flex gap-3 max-w-3xl",
        role === "user" ? "ml-auto flex-row-reverse" : "",
      )}
    >
      <div
        className={cn(
          "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
          role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {role === "user" ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
      </div>
      <div
        className={cn(
          "rounded-lg px-4 py-2 text-sm whitespace-pre-wrap break-words",
          role === "user"
            ? "bg-primary text-primary-foreground"
            : "bg-muted",
        )}
      >
        {text}
        {isStreaming && role === "assistant" && (
          <span className="inline-block w-1.5 h-4 ml-0.5 bg-foreground/50 animate-pulse" />
        )}
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

    // 找对应的凭证
    const cred = credentials.find((c) => c.providerId === model.providerId);
    if (!cred) {
      setStreamError("找不到对应凭证，请先在 API 接入页配置");
      return;
    }

    const apiKey = await getApiKey(cred.id);
    if (!apiKey) {
      setStreamError("API Key 未找到，请重新添加凭证");
      return;
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
    };

    const newMessages = [...messages, userMsg];
    setMessages([...newMessages, assistantMsg]);
    setIsStreaming(true);
    setStreamError(null);
    setSwitchNotice(null);

    const controller = new AbortController();
    abortRef.current = controller;

    // 构造端点（toModelEndpoint 内部校验 provider.type 缺省并抛错）
    let primary;
    try {
      primary = toModelEndpoint(model, cred, apiKey);
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : "构造模型端点失败");
      setIsStreaming(false);
      return;
    }

    // ChatPage 自由对话无项目模板上下文 → 单元素链（无 fallback）。
    // 想用 fallback 的用户应去项目页（v0.4 核心场景）。
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
            setSwitchNotice(`主模型失败，已自动切到 ${to.displayLabel ?? to.modelName}`);
          },
          onUsage: (usage) => {
            setLastUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
            // UsageEvent 落库已由 chat-fallback 内部完成（解决切 fallback 时写错 modelName 的旧 bug）
          },
        },
        { signal: controller.signal },
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setStreamError(err instanceof Error ? err.message : "对话失败");
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleFormSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const text = String(formData.get("input") ?? "").trim();
    if (!text || isStreaming) return;
    void handleSend(text);
    (e.currentTarget as HTMLFormElement).reset();
  }

  if (loadError) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>加载失败：{loadError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (availableModels.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md p-6">
          <Bot className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold mb-2">还没有可用的模型</h2>
          <p className="text-sm text-muted-foreground mb-4">
            请先在「API 接入」页添加 Provider 和 Model
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b p-3 flex items-center gap-2 bg-muted/30">
        <select
          value={selectedModelId}
          onChange={(e) => setSelectedModelId(e.target.value)}
          className="text-sm border rounded px-2 py-1 bg-background"
        >
          {availableModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName ?? m.name}
            </option>
          ))}
        </select>
        {lastUsage && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            上次：↑{lastUsage.inputTokens} ↓{lastUsage.outputTokens}
          </span>
        )}
        {switchNotice && (
          <span className="text-xs text-amber-600 whitespace-nowrap flex items-center gap-1">
            <Zap className="w-3 h-3" /> {switchNotice}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground mt-12">
            开始对话吧
          </div>
        ) : (
          messages.map((m) => {
            const isLastAssistant =
              m.role === "assistant" && m === messages[messages.length - 1];
            return (
              <MessageItem
                key={m.id}
                role={m.role}
                text={m.content}
                isStreaming={isLastAssistant && isStreaming}
              />
            );
          })
        )}
        {streamError && (
          <Alert variant="destructive">
            <AlertDescription>{streamError}</AlertDescription>
          </Alert>
        )}
      </div>

      <form onSubmit={handleFormSubmit} className="border-t p-3 flex gap-2">
        <input
          name="input"
          placeholder="输入消息..."
          disabled={isStreaming}
          autoComplete="off"
          className="flex-1 text-sm border rounded px-3 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {isStreaming ? (
          <Button type="button" variant="outline" onClick={handleStop}>
            <Square className="w-4 h-4" />
          </Button>
        ) : (
          <Button type="submit">
            <Send className="w-4 h-4" />
          </Button>
        )}
      </form>
    </div>
  );
}
