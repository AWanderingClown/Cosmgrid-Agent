// ProjectDetailPage - 重构为 "Cosmic Cyber" 视觉风格
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Cpu,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  Square,
  Trash2,
  User,
  XCircle,
  Zap,
  Terminal,
  ShieldCheck,
  ShieldAlert,
  BrainCircuit,
  Workflow
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  projects as dbProjects,
  workspaceConfigs as dbWorkspaceConfigs,
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
import { type ToolConfirmRequest } from "@/lib/llm/tools";
import { prepareWorkspaceToolRuntime, type WorkspaceToolRuntime } from "@/lib/llm/workspace-tool-runtime";
import { classifyLlmError } from "@/lib/llm/error-classifier";
import { buildTimePreamble, buildNoToolsPreamble, buildImageGuardPreamble, buildProjectMemoryPreamble } from "@/lib/llm/context-preamble";
import {
  projectMemories as dbMemories,
  memoryKindLabel,
  type ProjectMemory,
} from "@/lib/db";
import { CreateCheckpointDialog, CheckpointDetailDialog } from "@/components/project-detail/CheckpointDialogs";
import { GenerateHandoffDialog, HandoffDetailDialog } from "@/components/project-detail/HandoffDialogs";
import { AddMemoryDialog } from "@/components/project-detail/MemoryDialogs";
import { formatTime, roleLabel } from "@/components/project-detail/project-detail-utils";
import cosmgridLogo from "@/assets/cosmgrid-logo.svg";

// ============ 静态映射 ============

const STAGE_STATUS_COLOR: Record<string, { color: string; bg: string }> = {
  pending: { color: "text-muted-foreground", bg: "bg-muted/10" },
  running: { color: "text-primary", bg: "bg-primary/10" },
  active: { color: "text-primary", bg: "bg-primary/10" },
  completed: { color: "text-emerald-400", bg: "bg-emerald-400/10" },
  failed: { color: "text-red-400", bg: "bg-red-400/10" },
  interrupted: { color: "text-amber-400", bg: "bg-amber-400/10" },
};

function stageStatusLabel(status: string, t: (k: string) => string): string {
  const key = ["ready", "running", "active", "completed", "failed", "interrupted", "pending"].includes(status) ? status : "pending";
  return t(`projectDetail.stageStatus.${key}`);
}

const PROJECT_STATUS_COLOR: Record<string, { color: string; bg: string }> = {
  pending: { color: "text-blue-400", bg: "bg-blue-400/10" },
  active: { color: "text-emerald-400", bg: "bg-emerald-400/10" },
  paused: { color: "text-amber-400", bg: "bg-amber-400/10" },
  completed: { color: "text-indigo-400", bg: "bg-indigo-400/10" },
  failed: { color: "text-red-400", bg: "bg-red-400/10" },
};

function projectStatusLabel(status: string, t: (k: string) => string): string {
  const key = ["pending", "active", "paused", "completed", "failed"].includes(status) ? status : "pending";
  return t(`projectDetail.projectStatus.${key}`);
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
  const { t } = useTranslation();
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
          <img src={cosmgridLogo} className={cn("w-5 h-5", isStreaming && "animate-pulse")} alt={t("projectDetail.altBot")} />
        ) : (
          <User className="w-4 h-4" />
        )}
      </div>
      <div className="flex-1 space-y-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/40">
            {isAssistant ? t("projectDetail.chat.assistantLabel") : t("projectDetail.chat.userLabel")}
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

interface StageChatProps {
  stage: ProjectStage;
  model: Model;
  credential: ApiCredential;
  apiKey: string;
  conversationId: string;
  fallback: { model: Model; credential: ApiCredential; apiKey: string } | null;
}

function StageChat({ stage, model, credential, apiKey, conversationId, fallback }: StageChatProps) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<DbMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  // v0.7 阶段4b：写操作确认弹窗（diff 预览 + 确认/拒绝）
  const [pendingConfirm, setPendingConfirm] = useState<ToolConfirmRequest | null>(null);
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 工具确认回调：弹窗 + 返回 Promise，等用户点按钮 resolve
  function requestConfirm(req: ToolConfirmRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      setPendingConfirm(req);
      confirmResolverRef.current = resolve;
    });
  }
  function resolveConfirm(ok: boolean) {
    confirmResolverRef.current?.(ok);
    confirmResolverRef.current = null;
    setPendingConfirm(null);
  }

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
      setStreamErr(err instanceof Error ? err.message : t("projectDetail.chat.endpointFailed"));
      setStreaming(false);
      return;
    }

    const chain = fallback ? [primary, toModelEndpoint(fallback.model, fallback.credential, fallback.apiKey)] : [primary];

    // 项目设了工作区路径，就给 AI 挂上工作区工具；写工具仍走确认弹窗。
    let tools: WorkspaceToolRuntime["tools"];
    let workspacePreamble: string | null = null;
    let projectMemoryPreamble: string | null = null;
    try {
      const proj = await dbProjects.getById(stage.projectId);
      const memories = await dbMemories.listByProject(stage.projectId);
      projectMemoryPreamble = buildProjectMemoryPreamble(proj?.name, memories);
      if (proj?.workspacePath) {
        const blockedCommands = await dbWorkspaceConfigs.getBlockedCommands(stage.projectId);
        const runtime = await prepareWorkspaceToolRuntime({
          workspacePath: proj.workspacePath,
          includeWrite: true,
          projectId: stage.projectId,
          conversationId,
          confirm: requestConfirm,
          blockedCommands,
          includePreamble: true,
        });
        tools = runtime.tools;
        workspacePreamble = runtime.workspacePreamble;
      }
    } catch {
      // 取工作区失败不影响对话，只是没有工具
    }

    let full = "";
    try {
      await streamWithFallback(
        chain,
        [
          { role: "system" as const, content: buildTimePreamble() },
          ...(projectMemoryPreamble ? [{ role: "system" as const, content: projectMemoryPreamble }] : []),
          ...(workspacePreamble ? [{ role: "system" as const, content: workspacePreamble }] : []),
          ...(tools ? [{ role: "system" as const, content: buildImageGuardPreamble() }] : []),
          ...(!tools ? [{ role: "system" as const, content: buildNoToolsPreamble() }] : []),
          ...[...history, userMsg].map((m) => ({ role: m.role as any, content: m.content })),
        ],
        {
          onDelta: (delta) => {
            full += delta;
            setHistory((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: full } : m)));
          },
          onSwitched: (_from, to) => {
            setSwitchNotice(t("projectDetail.chat.failsafeSwitched", { name: to.displayLabel || to.modelName }));
          },
          onRecovered: (mode) => {
            setSwitchNotice(t(`projectDetail.chat.recovery.${mode}`));
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
        // role 不传：chat-fallback 内部按最后一条 user 消息推断难度桶
        { signal: controller.signal, projectId: stage.projectId, actorRole: "stage", ...(tools ? { tools } : {}) },
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setStreamErr(classifyLlmError(err, t).userMessage);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="relative flex flex-col h-[500px] glass border-x-0 border-b-0">
      {/* v0.7 阶段4b：写操作确认弹窗 */}
      {pendingConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6">
          <div className="glass border border-white/15 rounded-2xl max-w-2xl w-full max-h-[80%] flex flex-col shadow-2xl">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-white/10">
              <ShieldAlert className="w-4 h-4 text-amber-500" />
              <span className="font-bold text-sm">{t("projectDetail.tools.confirmTitle")}</span>
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
                {t("projectDetail.tools.reject")}
              </Button>
              <Button size="sm" className="rounded-xl bg-emerald-600 hover:bg-emerald-700" onClick={() => resolveConfirm(true)}>
                {t("projectDetail.tools.approve")}
              </Button>
            </div>
          </div>
        </div>
      )}
      {switchNotice && (
        <div className="px-4 py-2 bg-amber-500/10 text-[10px] font-bold text-amber-500 flex items-center gap-2 border-b border-amber-500/10">
          <Zap className="w-3 h-3" /> {switchNotice}
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full opacity-20 gap-4">
             <MessageSquare className="w-12 h-12" />
             <p className="text-[10px] font-black uppercase tracking-[0.4em]">{t("projectDetail.chat.awaiting")}</p>
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
            {t("projectDetail.chat.errorPrefix")}: {streamErr}
          </div>
        )}
      </div>
      <div className="p-4 bg-muted/20">
        <div className="flex gap-2 items-center bg-background/50 border border-white/10 rounded-2xl p-1.5 focus-within:border-primary/50 transition-all">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("projectDetail.chat.placeholder")}
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

export interface ProjectDetailPageProps {
  projectId: string;
  onBack: () => void;
}

export function ProjectDetailPage({ projectId, onBack }: ProjectDetailPageProps) {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const [project, setProject] = useState<Project | null>(null);
  const [stages, setStages] = useState<ProjectStage[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [templateRoles, setTemplateRoles] = useState<ProjectTemplateRole[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [, setHandoffs] = useState<HandoffPacket[]>([]);
  const [memories, setMemories] = useState<ProjectMemory[]>([]);
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const [createCpOpen, setCreateCpOpen] = useState(false);
  const [viewCp, setViewCp] = useState<Checkpoint | null>(null);
  const [genCp, setGenCp] = useState<Checkpoint | null>(null);
  const [viewHandoff, setViewHandoff] = useState<HandoffPacket | null>(null);
  const [addMemoryOpen, setAddMemoryOpen] = useState(false);
  const [relatedMemories, setRelatedMemories] = useState<ProjectMemory[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // v0.7 阶段4b：项目级命令黑名单（换行/逗号分隔）
  const [blockedInput, setBlockedInput] = useState("");
  const [blockedSaved, setBlockedSaved] = useState(false);

  async function load() {
    try {
      const [p, s, m, c, cp, hf, mem, blocked] = await Promise.all([
        dbProjects.getById(projectId),
        dbStages.listByProject(projectId),
        dbModels.listEnabled(),
        dbCredentials.list(),
        dbCheckpoints.listByProject(projectId),
        dbHandoffs.listByProject(projectId),
        dbMemories.listByProject(projectId),
        dbWorkspaceConfigs.getBlockedCommands(projectId),
      ]);
      if (!p) { setLoadError(t("projectDetail.notFound")); return; }
      setProject(p); setStages(s); setModels(m); setCredentials(c); setCheckpoints(cp); setHandoffs(hf); setMemories(mem);
      setBlockedInput(blocked.join("\n"));
      if (p.templateId) setTemplateRoles(await dbTemplateRoles.listByTemplate(p.templateId));
      const query = [p.name, p.description].filter(Boolean).join(" ");
      if (query) {
        setRelatedMemories(await dbMemories.searchAcrossProjects(query, {
          excludeProjectId: projectId,
          limit: 3,
          minImportance: 60,
          perProjectLimit: 1,
        }).catch(() => []));
      } else {
        setRelatedMemories([]);
      }
      setLoadError(null);
    } catch (err) { setLoadError(err instanceof Error ? err.message : t("projectDetail.loadError")); }
  }

  useEffect(() => { void load(); }, [projectId]);

  async function saveBlockedCommands() {
    const list = blockedInput.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    await dbWorkspaceConfigs.setBlockedCommands(projectId, list);
    setBlockedSaved(true);
    setTimeout(() => setBlockedSaved(false), 2000);
  }

  const modelMap = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  const credentialMap = useMemo(() => new Map(credentials.map((c) => [c.providerId, c])), [credentials]);

  async function startStage(stage: ProjectStage) {
    if (!project) return;
    await dbStages.update(stage.id, { status: "running" });
    await dbProjects.update(project.id, { currentStage: stage.workRole, status: "active" });
    await load(); setOpenStageId(stage.id);
  }

  async function completeStage(stage: ProjectStage) {
    await dbStages.update(stage.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    await load();
  }

  async function deleteCheckpoint(id: string) {
    if (!(await confirm({ description: t("projectDetail.deleteCheckpoint"), destructive: true }))) return;
    await dbCheckpoints.delete(id);
    await load();
  }

  async function deleteMemory(id: string) {
    if (!(await confirm({ description: t("projectDetail.deleteMemory"), destructive: true }))) return;
    await dbMemories.delete(id);
    await load();
  }

  const totalCost = stages.reduce((s, st) => s + st.cost, 0);
  const totalTokens = stages.reduce((s, st) => s + st.inputTokens + st.outputTokens, 0);

  if (loadError) return (
    <div className="p-8"><Alert variant="destructive" className="glass rounded-[2rem] border-red-500/30"><AlertDescription>{loadError}</AlertDescription></Alert></div>
  );

  if (!project) return <div className="h-full flex items-center justify-center animate-pulse"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>;

  const projectStatusKey = ["pending", "active", "paused", "completed", "failed"].includes(project.status) ? project.status : "pending";
  const projectStatus = {
    label: projectStatusLabel(projectStatusKey, t),
    ...(PROJECT_STATUS_COLOR[projectStatusKey] ?? PROJECT_STATUS_COLOR.pending!),
  };

  return (
    <div className="h-full w-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="space-y-12 pb-20">
        {/* Header Section */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-8 animate-in fade-in slide-in-from-top-4 duration-700">
          <div className="space-y-4 flex-1">
            <Button variant="ghost" size="sm" onClick={onBack} className="-ml-3 rounded-xl hover:bg-white/10 text-muted-foreground">
              <ArrowLeft className="w-4 h-4 mr-2" /> {t("projectDetail.returnToHub")}
            </Button>
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h1 className="text-4xl font-black tracking-tighter">{project.name}</h1>
                <div className={cn("px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-current/20", projectStatus.color, projectStatus.bg)}>
                  {projectStatus.label}
                </div>
              </div>
              <p className="text-muted-foreground text-sm font-medium opacity-60">{project.description || t("projectDetail.descFallback")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-6 pt-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-black text-muted-foreground/40 uppercase tracking-widest">{t("projectDetail.activeSequence")}</span>
                <span className="text-xs font-bold text-primary">{roleLabel(project.currentStage, t) || t("projectDetail.initialization")}</span>
              </div>
              <div className="w-px h-8 bg-white/5" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-black text-muted-foreground/40 uppercase tracking-widest">{t("projectDetail.accumulatedCost")}</span>
                <span className="text-xs font-bold font-mono text-emerald-400">{formatCost(totalCost)}</span>
              </div>
              <div className="w-px h-8 bg-white/5" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-black text-muted-foreground/40 uppercase tracking-widest">{t("projectDetail.neuralLoad")}</span>
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
                <CheckCircle2 className="w-4 h-4" /> {t("projectDetail.deployFinish")}
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
                <Workflow className="w-4 h-4" /> {t("projectDetail.operationalTimeline")}
              </h2>
            </div>
            <div className="space-y-4">
              {stages.map((st, idx) => {
                const m = modelMap.get(st.modelId);
                const isOpen = openStageId === st.id;
                const cred = m ? credentialMap.get(m.providerId) : undefined;
                const stageKey = ["pending", "running", "active", "completed", "failed", "interrupted"].includes(st.status) ? st.status : "pending";
                const status = {
                  label: stageStatusLabel(stageKey, t),
                  ...(STAGE_STATUS_COLOR[stageKey] ?? STAGE_STATUS_COLOR.pending!),
                };
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
                            <h3 className="text-lg font-bold tracking-tight">{roleLabel(st.workRole, t) || st.workRole}</h3>
                            <div className={cn("px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-tighter border border-current/20", status.color, status.bg)}>
                              {status.label}
                            </div>
                          </div>
                          <div className="flex items-center gap-3 text-[10px] font-bold text-muted-foreground/40 uppercase tracking-widest">
                            <span className="flex items-center gap-1"><Cpu className="w-3 h-3" /> {m?.displayName || t("projectDetail.systemModel")}</span>
                            <span>•</span>
                            <span className="flex items-center gap-1"><Terminal className="w-3 h-3" /> {st.outputTokens} tkn</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {st.status === "pending" ? (
                          <Button onClick={() => startStage(st)} className="rounded-xl h-10 px-5 bg-primary/20 hover:bg-primary text-primary hover:text-primary-foreground transition-all font-bold text-xs uppercase">
                            {t("projectDetail.startSequence")}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setOpenStageId(isOpen ? null : st.id)}
                            className={cn("h-10 px-4 rounded-xl gap-2 font-bold text-xs uppercase", isOpen ? "bg-primary text-primary-foreground" : "hover:bg-white/10")}
                          >
                            <MessageSquare className="w-4 h-4" />
                            {isOpen ? t("projectDetail.closeLogs") : t("projectDetail.viewDialog")}
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
                    <CheckCircle2 className="w-4 h-4" /> {t("projectDetail.coreCheckpoints")}
                  </h2>
                  <Button size="sm" variant="ghost" onClick={() => setCreateCpOpen(true)} className="h-7 w-7 p-0 rounded-lg bg-primary/10 text-primary hover:bg-primary hover:text-white">
                    <Plus className="w-4 h-4" />
                  </Button>
               </div>
               <div className="space-y-3">
                  {checkpoints.length === 0 ? (
                    <div className="glass border-dashed rounded-[2rem] p-8 text-center opacity-30">
                       <p className="text-[10px] font-black uppercase tracking-widest">{t("projectDetail.noRecords")}</p>
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
                          <Button variant="outline" size="sm" onClick={() => setViewCp(cp)} className="flex-1 h-8 rounded-lg text-[10px] uppercase font-bold border-white/10 hover:bg-white/5">{t("projectDetail.details")}</Button>
                          <Button size="sm" onClick={() => setGenCp(cp)} className="flex-1 h-8 rounded-lg text-[10px] uppercase font-bold bg-primary shadow-lg shadow-primary/10">{t("projectDetail.handoff")}</Button>
                       </div>
                    </Card>
                  ))}
               </div>
            </div>

            {/* 记忆板块 */}
            <div className="space-y-4">
               <div className="flex items-center justify-between px-2">
                  <h2 className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground/40 flex items-center gap-2">
                    <BrainCircuit className="w-4 h-4" /> {t("projectDetail.neuralMemory")}
                  </h2>
                  <Button size="sm" variant="ghost" onClick={() => setAddMemoryOpen(true)} className="h-7 w-7 p-0 rounded-lg bg-accent/10 text-accent hover:bg-accent hover:text-white">
                    <Plus className="w-4 h-4" />
                  </Button>
               </div>
               <div className="space-y-3">
                  {memories.length === 0 ? (
                    <div className="glass border-dashed rounded-[2rem] p-8 text-center opacity-30">
                       <p className="text-[10px] font-black uppercase tracking-widest">{t("projectDetail.emptyBuffer")}</p>
                    </div>
                  ) : memories.map(m => (
                    <Card key={m.id} className="glass border-white/5 rounded-[1.5rem] p-5 space-y-2 group transition-all">
                       <div className="flex items-center justify-between">
                          <div className={cn("px-2 py-0.5 rounded text-[8px] font-black uppercase",
                            m.kind === 'decision' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-accent/10 text-accent'
                          )}>
                             {memoryKindLabel(m.kind, t)}
                          </div>
                          <button onClick={() => void deleteMemory(m.id)} className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <XCircle className="w-3 h-3 text-red-500/50 hover:text-red-500" />
                          </button>
                       </div>
                       <h4 className="text-sm font-bold">{m.title}</h4>
                       <p className="text-[11px] text-muted-foreground/70 line-clamp-3 leading-relaxed">{m.content}</p>
                    </Card>
                  ))}
               </div>
               {relatedMemories.length > 0 && (
                 <div className="space-y-3 pt-2">
                   <div className="flex items-center justify-between px-1">
                     <h3 className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground/45 flex items-center gap-2">
                       <Workflow className="w-3.5 h-3.5" /> {t("projectDetail.relatedMemories.title")}
                     </h3>
                     <span className="text-[9px] text-muted-foreground/45">{t("projectDetail.relatedMemories.hint")}</span>
                   </div>
                   {relatedMemories.map((m) => (
                     <Card key={`related-${m.id}`} className="border border-white/8 bg-white/[0.03] rounded-[1.25rem] p-4 space-y-2">
                       <div className="flex items-center justify-between gap-3">
                         <div className={cn("px-2 py-0.5 rounded text-[8px] font-black uppercase",
                           m.kind === "decision" ? "bg-indigo-500/10 text-indigo-400" : "bg-accent/10 text-accent"
                         )}>
                           {memoryKindLabel(m.kind, t)}
                         </div>
                         <div className="text-[9px] font-bold text-amber-300/80">
                           {t("projectDetail.relatedMemories.fromProject", { name: m.projectName || t("projectDetail.relatedMemories.unknownProject") })}
                         </div>
                       </div>
                       <h4 className="text-sm font-bold">{m.title}</h4>
                       <p className="text-[11px] text-muted-foreground/70 line-clamp-3 leading-relaxed">{m.content}</p>
                     </Card>
                   ))}
                 </div>
               )}
            </div>
          </div>
        </div>

        {/* v0.7 阶段4b：项目工具安全 — 自定义命令黑名单 */}
        {project.workspacePath && (
          <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-4 shadow-xl">
            <div className="flex items-center gap-3 pb-2 border-b border-white/10">
              <ShieldAlert className="w-5 h-5 text-amber-500" />
              <h2 className="text-lg font-bold dark:text-white">{t("projectDetail.tools.safetyTitle")}</h2>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{t("projectDetail.tools.safetyDesc")}</p>
            <textarea
              value={blockedInput}
              onChange={(e) => setBlockedInput(e.target.value)}
              placeholder={t("projectDetail.tools.blockedPlaceholder")}
              className="w-full bg-white/5 dark:bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-xs font-mono outline-none focus:border-amber-500/40 resize-none h-24 dark:text-white"
            />
            <div className="flex items-center gap-3">
              <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void saveBlockedCommands()}>
                {t("projectDetail.tools.save")}
              </Button>
              {blockedSaved && <span className="text-xs font-bold text-emerald-500">{t("projectDetail.tools.saved")}</span>}
            </div>
          </Card>
        )}
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
  const { t } = useTranslation();
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
        if (!key) { setError(t("projectDetail.chat.apiKeyMissing")); return; }
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
      } catch (err) { setError(err instanceof Error ? err.message : t("projectDetail.chat.initFailed")); }
    })();
  }, [stage.id]);

  if (error) return <div className="p-4 text-xs font-bold text-red-500 bg-red-500/5">{error}</div>;
  if (!conversationId || !apiKey) return <div className="p-10 flex items-center justify-center gap-3"><Loader2 className="w-5 h-5 text-primary animate-spin" /><span className="text-xs font-black uppercase tracking-widest opacity-30">{t("projectDetail.chat.syncing")}</span></div>;

  return <StageChat stage={stage} model={model} credential={credential} apiKey={apiKey} conversationId={conversationId} fallback={fallback} />;
}
