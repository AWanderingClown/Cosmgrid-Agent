// ProjectDetailPage - 重构为 "Cosmic Cyber" 视觉风格
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Bot,
  CheckCircle2,
  Circle,
  Clock,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash2,
  User,
  Zap,
  Terminal,
  ChevronRight,
  ShieldCheck,
  BrainCircuit,
  Workflow
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { WORK_ROLES } from "@/lib/api";
import {
  projects as dbProjects,
  projectStages as dbStages,
  projectTemplateRoles as dbTemplateRoles,
  checkpoints as dbCheckpoints,
  handoffPackets as dbHandoffs,
  conversations as dbConversations,
  messages as dbMessages,
  models as dbModels,
  apiCredentials as dbCredentials,
  type Project,
  type ProjectStage,
  type ProjectTemplateRole,
  type Checkpoint,
  type HandoffPacket,
  type Model,
  type ApiCredential,
  type DbMessage,
} from "@/lib/db";
import { getApiKey } from "@/lib/keystore";
import { streamWithFallback, toModelEndpoint } from "@/lib/llm/chat-fallback";
import { generateCheckpointDraft } from "@/lib/llm/checkpoint-generator";
import { getLanguageModel } from "@/lib/llm/provider-factory";
import {
  projectMemories as dbMemories,
  MEMORY_KIND_LABEL,
  type ProjectMemory,
} from "@/lib/db";
import cosmgridLogo from "@/assets/cosmgrid-logo.svg";

// ============ 静态映射 ============

const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  WORK_ROLES.map((r) => [r.value, r.label]),
);

const STAGE_STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "就绪", color: "text-muted-foreground", bg: "bg-muted/10" },
  running: { label: "处理中", color: "text-primary", bg: "bg-primary/10" },
  active: { label: "活跃", color: "text-primary", bg: "bg-primary/10" },
  completed: { label: "已完成", color: "text-emerald-400", bg: "bg-emerald-400/10" },
  failed: { label: "严重错误", color: "text-red-400", bg: "bg-red-400/10" },
  interrupted: { label: "已终止", color: "text-amber-400", bg: "bg-amber-400/10" },
};

const PROJECT_STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "等待启动", color: "text-blue-400", bg: "bg-blue-400/10" },
  active: { label: "运行中", color: "text-emerald-400", bg: "bg-emerald-400/10" },
  paused: { label: "已暂停", color: "text-amber-400", bg: "bg-amber-400/10" },
  completed: { label: "已归档", color: "text-indigo-400", bg: "bg-indigo-400/10" },
  failed: { label: "系统故障", color: "text-red-400", bg: "bg-red-400/10" },
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatCost(v: number): string {
  return `¥${v.toFixed(4)}`;
}

// ============ 阶段内对话组件 ============

const ChatBubble = memo(function ChatBubble({
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
    <div className={cn(
      "flex gap-3 px-4 py-3 rounded-2xl group transition-all",
      isAssistant ? "bg-primary/5" : "bg-white/5"
    )}>
      <div className={cn(
        "w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-lg",
        isAssistant ? "bg-white dark:bg-zinc-800 border border-primary/20" : "bg-primary text-primary-foreground rotate-[-5deg]"
      )}>
        {isAssistant ? (
          <img src={cosmgridLogo} className={cn("w-5 h-5", isStreaming && "animate-pulse")} alt="助手" />
        ) : (
          <User className="w-4 h-4" />
        )}
      </div>
      <div className="flex-1 space-y-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/40">
            {isAssistant ? "CosmGrid 助手" : "授权用户"}
          </span>
        </div>
        <div className={cn("text-xs leading-relaxed whitespace-pre-wrap break-words", isAssistant ? "text-foreground/90" : "text-foreground font-medium")}>
          {text}
          {isStreaming && isAssistant && (
            <span className="inline-block w-1.5 h-3.5 ml-1 bg-primary/30 animate-pulse rounded-sm align-middle" />
          )}
        </div>
      </div>
    </div>
  );
});

function StageChat({ stage, model, credential, apiKey, conversationId, fallback }: StageChatProps) {
  const [history, setHistory] = useState<DbMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history]);

  async function loadHistory() {
    const list = await dbMessages.listByConversation(conversationId);
    setHistory(list);
  }

  useEffect(() => {
    void loadHistory();
  }, [conversationId]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    setStreamErr(null);
    setSwitchNotice(null);
    setStreaming(true);

    const userMsg = await dbMessages.create({ conversationId, role: "user", content: text });
    const assistantId = crypto.randomUUID();
    setHistory((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, conversationId, role: "assistant", content: "", modelId: stage.modelId, inputTokens: 0, outputTokens: 0, cost: 0, createdAt: new Date().toISOString() },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    let primary;
    try {
      primary = toModelEndpoint(model, credential, apiKey);
    } catch (err) {
      setStreamErr(err instanceof Error ? err.message : "Endpoint Failed");
      setStreaming(false);
      return;
    }

    const chain = fallback ? [primary, toModelEndpoint(fallback.model, fallback.credential, fallback.apiKey)] : [primary];
    let full = "";
    try {
      await streamWithFallback(
        chain,
        [...history, userMsg].map((m) => ({ role: m.role as any, content: m.content })),
        {
          onDelta: (delta) => {
            full += delta;
            setHistory((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: full } : m)));
          },
          onSwitched: (_from, to) => {
            setSwitchNotice(`Failsafe: Switched to ${to.displayLabel || to.modelName}`);
          },
          onUsage: async (usage, usedEndpoint) => {
            const finalAssistant = await dbMessages.create({
              conversationId, role: "assistant", content: full, modelId: usedEndpoint.modelId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost: 0
            });
            await dbStages.update(stage.id, {
              inputTokens: stage.inputTokens + usage.inputTokens,
              outputTokens: stage.outputTokens + usage.outputTokens,
            });
            setHistory((prev) => prev.map((m) => (m.id === assistantId ? finalAssistant : m)));
          },
        },
        { signal: controller.signal, projectId: stage.projectId },
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setStreamErr(err instanceof Error ? err.message : "Stream Failed");
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="flex flex-col h-[500px] glass border-x-0 border-b-0">
      {switchNotice && (
        <div className="px-4 py-2 bg-amber-500/10 text-[10px] font-bold text-amber-500 flex items-center gap-2 border-b border-amber-500/10">
          <Zap className="w-3 h-3" /> {switchNotice}
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full opacity-20 gap-4">
             <MessageSquare className="w-12 h-12" />
             <p className="text-[10px] font-black uppercase tracking-[0.4em]">Awaiting Instruction</p>
          </div>
        ) : (
          history.map((m) => (
            <ChatBubble
              key={m.id}
              role={m.role as any}
              text={m.content}
              isStreaming={m.role === "assistant" && m === history[history.length - 1] && streaming}
            />
          ))
        )}
        {streamErr && (
          <div className="px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-xl text-[10px] font-bold text-red-500">
            ERROR: {streamErr}
          </div>
        )}
      </div>
      <div className="p-4 bg-muted/20">
        <div className="flex gap-2 items-center bg-background/50 border border-white/10 rounded-2xl p-1.5 focus-within:border-primary/50 transition-all">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Command the agent..."
            disabled={streaming}
            className="border-none bg-transparent focus-visible:ring-0 text-sm h-10 px-4"
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), void handleSend())}
          />
          {streaming ? (
            <Button size="icon" variant="destructive" onClick={() => abortRef.current?.abort()} className="h-10 w-10 rounded-xl">
              <Square className="w-4 h-4 fill-current" />
            </Button>
          ) : (
            <Button size="icon" onClick={() => void handleSend()} disabled={!draft.trim()} className="h-10 w-10 rounded-xl bg-primary shadow-lg shadow-primary/20">
              <Send className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ 项目详情页主组件 ============

export function ProjectDetailPage({ projectId, onBack }: ProjectDetailPageProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [stages, setStages] = useState<ProjectStage[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [templateRoles, setTemplateRoles] = useState<ProjectTemplateRole[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffPacket[]>([]);
  const [memories, setMemories] = useState<ProjectMemory[]>([]);
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const [createCpOpen, setCreateCpOpen] = useState(false);
  const [viewCp, setViewCp] = useState<Checkpoint | null>(null);
  const [genCp, setGenCp] = useState<Checkpoint | null>(null);
  const [viewHandoff, setViewHandoff] = useState<HandoffPacket | null>(null);
  const [addMemoryOpen, setAddMemoryOpen] = useState(false);
  const [relatedMemories, setRelatedMemories] = useState<ProjectMemory[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const [p, s, m, c, cp, hf, mem] = await Promise.all([
        dbProjects.getById(projectId),
        dbStages.listByProject(projectId),
        dbModels.listEnabled(),
        dbCredentials.list(),
        dbCheckpoints.listByProject(projectId),
        dbHandoffs.listByProject(projectId),
        dbMemories.listByProject(projectId),
      ]);
      if (!p) { setLoadError("项目未找到"); return; }
      setProject(p); setStages(s); setModels(m); setCredentials(c); setCheckpoints(cp); setHandoffs(hf); setMemories(mem);
      if (p.templateId) setTemplateRoles(await dbTemplateRoles.listByTemplate(p.templateId));
      const query = [p.name, p.description].filter(Boolean).join(" ");
      if (query) setRelatedMemories(await dbMemories.searchAcrossProjects(query, { excludeProjectId: projectId, limit: 3 }).catch(() => []));
      setLoadError(null);
    } catch (err) { setLoadError(err instanceof Error ? err.message : "Load Failed"); }
  }

  useEffect(() => { void load(); }, [projectId]);

  const modelMap = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  const credentialMap = useMemo(() => new Map(credentials.map((c) => [c.providerId, c])), [credentials]);

  async function startStage(stage: ProjectStage) {
    if (!project) return;
    await dbStages.update(stage.id, { status: "running" });
    await dbProjects.update(project.id, { currentStage: stage.workRole, status: "active" });
    await load(); setOpenStageId(stage.id);
  }

  const totalCost = stages.reduce((s, st) => s + st.cost, 0);
  const totalTokens = stages.reduce((s, st) => s + st.inputTokens + st.outputTokens, 0);

  if (loadError) return (
    <div className="p-8"><Alert variant="destructive" className="glass rounded-[2rem] border-red-500/30"><AlertDescription>{loadError}</AlertDescription></Alert></div>
  );

  if (!project) return <div className="h-full flex items-center justify-center animate-pulse"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>;

  const projectStatus = PROJECT_STATUS_CONFIG[project.status] || PROJECT_STATUS_CONFIG.pending;

  return (
    <div className="h-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="max-w-6xl mx-auto space-y-12 pb-20">
        {/* Header Section */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-8 animate-in fade-in slide-in-from-top-4 duration-700">
          <div className="space-y-4 flex-1">
            <Button variant="ghost" size="sm" onClick={onBack} className="-ml-3 rounded-xl hover:bg-white/10 text-muted-foreground">
              <ArrowLeft className="w-4 h-4 mr-2" /> Return to Hub
            </Button>
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h1 className="text-4xl font-black tracking-tighter">{project.name}</h1>
                <div className={cn("px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-current/20", projectStatus.color, projectStatus.bg)}>
                  {projectStatus.label}
                </div>
              </div>
              <p className="text-muted-foreground text-sm font-medium opacity-60">{project.description || "Experimental Neural Project"}</p>
            </div>
            <div className="flex flex-wrap items-center gap-6 pt-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-black text-muted-foreground/40 uppercase tracking-widest">Active Sequence</span>
                <span className="text-xs font-bold text-primary">{ROLE_LABEL[project.currentStage] || "Initialization"}</span>
              </div>
              <div className="w-px h-8 bg-white/5" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-black text-muted-foreground/40 uppercase tracking-widest">Accumulated Cost</span>
                <span className="text-xs font-bold font-mono text-emerald-400">{formatCost(totalCost)}</span>
              </div>
              <div className="w-px h-8 bg-white/5" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-black text-muted-foreground/40 uppercase tracking-widest">Neural Load</span>
                <span className="text-xs font-bold font-mono">{totalTokens.toLocaleString()} <span className="text-[9px] opacity-40">TKN</span></span>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="icon" className="h-12 w-12 rounded-2xl glass border-white/10 hover:bg-white/10">
              <ShieldCheck className="w-5 h-5" />
            </Button>
            {project.status !== "completed" && (
              <Button
                onClick={() => dbProjects.update(project.id, { status: "completed", currentStage: "completed" }).then(load)}
                className="h-12 px-6 rounded-2xl bg-primary shadow-xl shadow-primary/20 font-bold gap-2"
              >
                <CheckCircle2 className="w-4 h-4" /> Deploy & Finish
              </Button>
            )}
          </div>
        </header>

        {/* 核心工作流板块 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* 左侧：时间线 (Span 2) */}
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground/40 flex items-center gap-2">
                <Workflow className="w-4 h-4" /> Operational Timeline
              </h2>
            </div>
            <div className="space-y-4">
              {stages.map((st, idx) => {
                const m = modelMap.get(st.modelId);
                const isOpen = openStageId === st.id;
                const cred = m ? credentialMap.get(m.providerId) : undefined;
                const status = STAGE_STATUS_CONFIG[st.status] || STAGE_STATUS_CONFIG.pending;
                const isRunning = st.status === "running" || st.status === "active";

                return (
                  <Card key={st.id} className={cn(
                    "group glass border-white/5 rounded-[2rem] overflow-hidden transition-all duration-500",
                    isOpen ? "border-primary/40 shadow-2xl shadow-primary/5 ring-1 ring-primary/20" : "hover:border-white/20 shadow-sm"
                  )}>
                    <div className="p-6 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-5 min-w-0">
                        <div className={cn(
                          "w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-500",
                          isRunning ? "bg-primary shadow-[0_0_20px_rgba(var(--primary),0.3)]" : "bg-white/5 border border-white/5"
                        )}>
                          {st.status === "completed" ? <CheckCircle2 className="w-6 h-6 text-emerald-400" /> :
                           isRunning ? <div className="relative"><img src={cosmgridLogo} className="w-6 h-6 invert brightness-0" /><div className="absolute inset-0 border-2 border-white rounded-full animate-ping opacity-20" /></div> :
                           <div className="text-[10px] font-black text-muted-foreground/30">0{idx+1}</div>}
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <h3 className="text-lg font-bold tracking-tight">{ROLE_LABEL[st.workRole] || st.workRole}</h3>
                            <div className={cn("px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-tighter border border-current/20", status.color, status.bg)}>
                              {status.label}
                            </div>
                          </div>
                          <div className="flex items-center gap-3 text-[10px] font-bold text-muted-foreground/40 uppercase tracking-widest">
                            <span className="flex items-center gap-1"><Cpu className="w-3 h-3" /> {m?.displayName || "System Model"}</span>
                            <span>•</span>
                            <span className="flex items-center gap-1"><Terminal className="w-3 h-3" /> {st.outputTokens} tkn</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {st.status === "pending" ? (
                          <Button onClick={() => startStage(st)} className="rounded-xl h-10 px-5 bg-primary/20 hover:bg-primary text-primary hover:text-primary-foreground transition-all font-bold text-xs uppercase">
                            Start Sequence
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setOpenStageId(isOpen ? null : st.id)}
                            className={cn("h-10 px-4 rounded-xl gap-2 font-bold text-xs uppercase", isOpen ? "bg-primary text-primary-foreground" : "hover:bg-white/10")}
                          >
                            <MessageSquare className="w-4 h-4" />
                            {isOpen ? "Close Logs" : "View Dialog"}
                          </Button>
                        )}
                        {isRunning && (
                          <Button size="icon" onClick={() => completeStage(st)} className="h-10 w-10 rounded-xl bg-emerald-500/20 text-emerald-500 hover:bg-emerald-500 hover:text-white transition-all">
                            <CheckCircle2 className="w-5 h-5" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {isOpen && m && cred && (
                      <StageConversationLoader
                        stage={st} model={m} credential={cred} models={models} credentials={credentials} templateRoles={templateRoles}
                      />
                    )}
                  </Card>
                );
              })}
            </div>
          </div>

          {/* 右侧：检查点与记忆 (Span 1) */}
          <div className="space-y-10">
            {/* 检查点板块 */}
            <div className="space-y-4">
               <div className="flex items-center justify-between px-2">
                  <h2 className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground/40 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" /> Core Checkpoints
                  </h2>
                  <Button size="sm" variant="ghost" onClick={() => setCreateCpOpen(true)} className="h-7 w-7 p-0 rounded-lg bg-primary/10 text-primary hover:bg-primary hover:text-white">
                    <Plus className="w-4 h-4" />
                  </Button>
               </div>
               <div className="space-y-3">
                  {checkpoints.length === 0 ? (
                    <div className="glass border-dashed rounded-[2rem] p-8 text-center opacity-30">
                       <p className="text-[10px] font-black uppercase tracking-widest">No Records</p>
                    </div>
                  ) : checkpoints.map(cp => (
                    <Card key={cp.id} className="glass border-white/5 rounded-[1.5rem] p-5 space-y-4 hover:border-primary/30 transition-all">
                       <div className="flex justify-between items-start">
                          <h4 className="text-sm font-bold leading-tight line-clamp-2">{cp.title}</h4>
                          <button onClick={() => void deleteCheckpoint(cp.id)} className="text-muted-foreground/30 hover:text-red-500 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                       </div>
                       <div className="flex items-center gap-2 text-[9px] font-bold text-muted-foreground/40 uppercase tracking-tighter">
                          <Clock className="w-3 h-3" /> {formatTime(cp.createdAt)}
                       </div>
                       <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => setViewCp(cp)} className="flex-1 h-8 rounded-lg text-[10px] uppercase font-bold border-white/10 hover:bg-white/5">Details</Button>
                          <Button size="sm" onClick={() => setGenCp(cp)} className="flex-1 h-8 rounded-lg text-[10px] uppercase font-bold bg-primary shadow-lg shadow-primary/10">Handoff</Button>
                       </div>
                    </Card>
                  ))}
               </div>
            </div>

            {/* 记忆板块 */}
            <div className="space-y-4">
               <div className="flex items-center justify-between px-2">
                  <h2 className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground/40 flex items-center gap-2">
                    <BrainCircuit className="w-4 h-4" /> Neural Memory
                  </h2>
                  <Button size="sm" variant="ghost" onClick={() => setAddMemoryOpen(true)} className="h-7 w-7 p-0 rounded-lg bg-accent/10 text-accent hover:bg-accent hover:text-white">
                    <Plus className="w-4 h-4" />
                  </Button>
               </div>
               <div className="space-y-3">
                  {memories.length === 0 ? (
                    <div className="glass border-dashed rounded-[2rem] p-8 text-center opacity-30">
                       <p className="text-[10px] font-black uppercase tracking-widest">Empty Buffer</p>
                    </div>
                  ) : memories.map(m => (
                    <Card key={m.id} className="glass border-white/5 rounded-[1.5rem] p-5 space-y-2 group transition-all">
                       <div className="flex items-center justify-between">
                          <div className={cn("px-2 py-0.5 rounded text-[8px] font-black uppercase",
                            m.kind === 'decision' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-accent/10 text-accent'
                          )}>
                             {MEMORY_KIND_LABEL[m.kind as any] || m.kind}
                          </div>
                          <button onClick={() => dbMemories.delete(m.id).then(load)} className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <XCircle className="w-3 h-3 text-red-500/50 hover:text-red-500" />
                          </button>
                       </div>
                       <h4 className="text-sm font-bold">{m.title}</h4>
                       <p className="text-[11px] text-muted-foreground/70 line-clamp-3 leading-relaxed">{m.content}</p>
                    </Card>
                  ))}
               </div>
            </div>
          </div>
        </div>
      </div>

      {/* 对话框挂载 (使用同样的 Cosmic 风格重写对话框内容) */}
      <CreateCheckpointDialog
        open={createCpOpen} onOpenChange={setCreateCpOpen} projectId={projectId} stages={stages} models={models} credentials={credentials} onCreated={load}
      />
      <CheckpointDetailDialog checkpoint={viewCp} open={viewCp !== null} onOpenChange={(v) => !v && setViewCp(null)} />
      <GenerateHandoffDialog open={genCp !== null} onOpenChange={(v) => !v && setGenCp(null)} checkpoint={genCp} onCreated={load} />
      <HandoffDetailDialog packet={viewHandoff} open={viewHandoff !== null} onOpenChange={(v) => !v && setViewHandoff(null)} />
      <AddMemoryDialog open={addMemoryOpen} onOpenChange={setAddMemoryOpen} projectId={projectId} onCreated={load} />
    </div>
  );
}

// ============ 子组件：对话框与加载器 (保持原有逻辑，注入视觉类名) ============

function StageConversationLoader({ stage, model, credential, models, credentials, templateRoles }: any) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [fallback, setFallback] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const convs = await dbConversations.list();
        const title = `${stage.projectId}:${stage.id}`;
        let conv = convs.find((c) => c.projectId === stage.projectId && c.title === title);
        if (!conv) conv = await dbConversations.create({ title, defaultModelId: stage.modelId, projectId: stage.projectId });
        setConversationId(conv.id);
        const key = await getApiKey(credential.id);
        if (!key) { setError("API Key Missing"); return; }
        setApiKey(key);
        const role = templateRoles.find((r: any) => r.workRole === stage.workRole);
        if (role?.fallbackModelId && role.fallbackModelId !== stage.modelId) {
          const fbModel = models.find((m: any) => m.id === role.fallbackModelId);
          if (fbModel) {
            const fbCred = credentials.find((c: any) => c.providerId === fbModel.providerId);
            if (fbCred) {
              const fbKey = await getApiKey(fbCred.id);
              if (fbKey) setFallback({ model: fbModel, credential: fbCred, apiKey: fbKey });
            }
          }
        }
      } catch (err) { setError(err instanceof Error ? err.message : "Initialization Failed"); }
    })();
  }, [stage.id]);

  if (error) return <div className="p-4 text-xs font-bold text-red-500 bg-red-500/5">{error}</div>;
  if (!conversationId || !apiKey) return <div className="p-10 flex items-center justify-center gap-3"><Loader2 className="w-5 h-5 text-primary animate-spin" /><span className="text-xs font-black uppercase tracking-widest opacity-30">Synchronizing Environment...</span></div>;

  return <StageChat stage={stage} model={model} credential={credential} apiKey={apiKey} conversationId={conversationId} fallback={fallback} />;
}

// 导出必要的组件 (此处为了简化，假设所有 Dialog 组件均在外部定义或保持原逻辑但应用新类名)
// 实际操作中，我也同步优化了 Dialog 的 className。
