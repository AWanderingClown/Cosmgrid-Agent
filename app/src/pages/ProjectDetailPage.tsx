// ProjectDetailPage - 项目详情页（7.6 多 AI 协作面板 / 4.10 接力 / 7.12 检查点）
// 阶段时间线 + 阶段对话（复用 ChatPage 的 streamWithFallback 模式）+ 检查点 CRUD + 接力包生成
// v0.4.1：阶段对话改用 streamWithFallback，按 stage.workRole 找模板里的 fallback；UsageEvent 落盘
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
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

// ============ 静态映射 ============

const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  WORK_ROLES.map((r) => [r.value, r.label]),
);

const STAGE_STATUS_LABEL: Record<string, string> = {
  pending: "待启动",
  running: "进行中",
  active: "进行中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

const STAGE_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  running: "default",
  active: "default",
  completed: "secondary",
  failed: "destructive",
  interrupted: "secondary",
};

const PROJECT_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  active: "default",
  paused: "secondary",
  completed: "secondary",
  failed: "destructive",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function formatCost(v: number): string {
  return `¥${v.toFixed(2)}`;
}

// ============ 阶段内对话组件（复用 ChatPage streamWithFallback 模式）============

interface StageChatProps {
  stage: ProjectStage;
  model: Model;
  credential: ApiCredential;
  apiKey: string;
  conversationId: string;
  fallback: { model: Model; credential: ApiCredential; apiKey: string } | null;
}

const ChatBubble = memo(function ChatBubble({
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
        "flex gap-2 max-w-3xl",
        role === "user" ? "ml-auto flex-row-reverse" : "",
      )}
    >
      <div
        className={cn(
          "w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs",
          role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {role === "user" ? <User className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
      </div>
      <div
        className={cn(
          "rounded-lg px-3 py-1.5 text-xs whitespace-pre-wrap break-words",
          role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {text}
        {isStreaming && role === "assistant" && (
          <span className="inline-block w-1 h-3 ml-0.5 bg-foreground/50 animate-pulse" />
        )}
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

  async function loadHistory() {
    const list = await dbMessages.listByConversation(conversationId);
    setHistory(list);
  }

  useEffect(() => {
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    setStreamErr(null);
    setSwitchNotice(null);
    setStreaming(true);

    // 持久化 user 消息
    const userMsg = await dbMessages.create({
      conversationId,
      role: "user",
      content: text,
    });

    // 准备 assistant 占位（不入库，边流边建）
    const assistantId = crypto.randomUUID();
    setHistory((prev) => [
      ...prev,
      userMsg,
      {
        id: assistantId,
        conversationId,
        role: "assistant",
        content: "",
        modelId: stage.modelId,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        createdAt: new Date().toISOString(),
      },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    // 构造端点（toModelEndpoint 内部校验 provider.type 缺省并抛错）
    let primary;
    try {
      primary = toModelEndpoint(model, credential, apiKey);
    } catch (err) {
      setStreamErr(err instanceof Error ? err.message : "构造模型端点失败");
      setStreaming(false);
      return;
    }

    // fallback 是 ProjectTemplateRole.fallbackModelId 对应的模型（无则单元素链）
    const chain = fallback
      ? [
          primary,
          toModelEndpoint(fallback.model, fallback.credential, fallback.apiKey),
        ]
      : [primary];

    let full = "";
    try {
      await streamWithFallback(
        chain,
        [...history, userMsg].map((m) => ({
          role: m.role as "user" | "assistant" | "system",
          content: m.content,
        })),
        {
          onDelta: (delta) => {
            full += delta;
            setHistory((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: full } : m)),
            );
          },
          onSwitched: (_from, to, reason) => {
            // 区分"出错切"和"cooldown 跳过"给用户更准的提示
            const reasonText = reason.kind === "cooldown" ? "（熔断跳过）" : `（${reason.category}）`;
            setSwitchNotice(`主模型不可用${reasonText}，已自动切到 ${to.displayLabel ?? to.modelName}`);
          },
          onUsage: async (usage, usedEndpoint) => {
            // 流式结束 → 入库真实消息（用实际调用的端点 id，不再手动反向 lookup）
            const finalAssistant = await dbMessages.create({
              conversationId,
              role: "assistant",
              content: full,
              modelId: usedEndpoint.modelId,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cost: 0,
            });
            // 更新 stage token 用量
            await dbStages.update(stage.id, {
              inputTokens: stage.inputTokens + usage.inputTokens,
              outputTokens: stage.outputTokens + usage.outputTokens,
            });
            setHistory((prev) => prev.map((m) => (m.id === assistantId ? finalAssistant : m)));
            // UsageEvent 落库已由 chat-fallback 内部完成（用 usedEndpoint 的真实 modelName/providerId，
            // 修切 fallback 时还误用 primary 信息的旧 bug）
          },
        },
        { signal: controller.signal, projectId: stage.projectId },
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setStreamErr(err instanceof Error ? err.message : "对话失败");
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  return (
    <div className="border-t bg-background">
      {switchNotice && (
        <div className="px-3 py-1.5 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-700 dark:text-amber-300 flex items-center gap-1 border-b">
          <Zap className="w-3 h-3" /> {switchNotice}
        </div>
      )}
      <div className="max-h-80 overflow-y-auto p-3 space-y-2">
        {history.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-4">
            这个阶段还没有对话，输点什么开始吧
          </div>
        ) : (
          history.map((m) => {
            const isLastAssistant =
              m.role === "assistant" && m === history[history.length - 1];
            return (
              <ChatBubble
                key={m.id}
                role={m.role as "user" | "assistant"}
                text={m.content}
                isStreaming={isLastAssistant && streaming}
              />
            );
          })
        )}
        {streamErr && (
          <Alert variant="destructive" className="py-2">
            <AlertDescription className="text-xs">{streamErr}</AlertDescription>
          </Alert>
        )}
      </div>
      <div className="border-t p-2 flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="输入消息..."
          disabled={streaming}
          autoComplete="off"
          className="text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        {streaming ? (
          <Button type="button" variant="outline" size="sm" onClick={handleStop}>
            <Square className="w-3.5 h-3.5" />
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={() => void handleSend()} disabled={!draft.trim()}>
            <Send className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

// ============ 创建检查点对话框 ============

function CreateCheckpointDialog({
  open,
  onOpenChange,
  projectId,
  stages,
  models,
  credentials,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  stages: ProjectStage[];
  models: Model[];
  credentials: ApiCredential[];
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [completedSummary, setCompletedSummary] = useState("");
  const [currentContext, setCurrentContext] = useState("");
  const [decisions, setDecisions] = useState("");
  const [failedAttempts, setFailedAttempts] = useState("");
  const [blockers, setBlockers] = useState("");
  const [nextSteps, setNextSteps] = useState("");
  const [doNotRepeat, setDoNotRepeat] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 阶段已经开始过（有进行中/已完成/失败状态）才可能有对话历史，AI 生成才有意义
  const stagesWithConversation = stages.filter((s) => s.status !== "pending");
  const [selectedStageId, setSelectedStageId] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  // 记录"已经自动生成过的阶段 id"，避免每次重渲染都重复触发；对话框关闭时清空，下次打开重新自动生成
  const autoGeneratedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      autoGeneratedForRef.current = null;
      return;
    }
    if (!selectedStageId && stagesWithConversation.length > 0) {
      setSelectedStageId(stagesWithConversation[stagesWithConversation.length - 1]!.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stages]);

  // 选好阶段后不需要用户再点一下——直接自动生成草稿，按钮只用来"重新生成"
  useEffect(() => {
    if (open && selectedStageId && autoGeneratedForRef.current !== selectedStageId) {
      autoGeneratedForRef.current = selectedStageId;
      void handleGenerate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedStageId]);

  function reset() {
    setTitle("");
    setGoal("");
    setCompletedSummary("");
    setCurrentContext("");
    setDecisions("");
    setFailedAttempts("");
    setBlockers("");
    setNextSteps("");
    setDoNotRepeat("");
    setAcceptanceCriteria("");
    setError(null);
    setSelectedStageId("");
    setGenerateError(null);
    autoGeneratedForRef.current = null;
  }

  async function handleGenerate() {
    const stage = stages.find((s) => s.id === selectedStageId);
    if (!stage) {
      setGenerateError("请先选择一个阶段");
      return;
    }
    const model = models.find((m) => m.id === stage.modelId);
    const credential = model && credentials.find((c) => c.providerId === model.providerId);
    if (!model || !credential || !model.provider?.type) {
      setGenerateError("这个阶段缺少可用的模型或凭证，无法用 AI 生成");
      return;
    }

    setGenerating(true);
    setGenerateError(null);
    try {
      const convs = await dbConversations.list();
      const convTitle = `${stage.projectId}:${stage.id}`;
      const conv = convs.find((c) => c.projectId === stage.projectId && c.title === convTitle);
      const history = conv ? await dbMessages.listByConversation(conv.id) : [];

      const apiKey = await getApiKey(credential.id);
      if (!apiKey) {
        setGenerateError("API Key 未找到，请重新添加凭证");
        return;
      }

      const languageModel = getLanguageModel(
        model.provider.type,
        model.name,
        apiKey,
        credential.baseUrl,
      );
      const draft = await generateCheckpointDraft(
        languageModel,
        history.map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content })),
      );

      setTitle(draft.title);
      setGoal(draft.goal);
      setCompletedSummary(draft.completedSummary);
      setCurrentContext(draft.currentContext);
      setDecisions(draft.decisions);
      setFailedAttempts(draft.failedAttempts);
      setBlockers(draft.blockers);
      setNextSteps(draft.nextSteps);
      setDoNotRepeat(draft.doNotRepeat);
      setAcceptanceCriteria(draft.acceptanceCriteria);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  }

  async function handleSave() {
    if (!title.trim()) {
      setError("请填写标题");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await dbCheckpoints.create({
        projectId,
        title: title.trim(),
        goal: goal.trim() || null,
        completedSummary: completedSummary.trim() || null,
        currentContext: currentContext.trim() || null,
        decisions: decisions.trim() || null,
        failedAttempts: failedAttempts.trim() || null,
        blockers: blockers.trim() || null,
        nextSteps: nextSteps.trim() || null,
        doNotRepeat: doNotRepeat.trim() || null,
        acceptanceCriteria: acceptanceCriteria.trim() || null,
      });
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>创建检查点</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {error && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}
          {stagesWithConversation.length > 0 && (
            <div className="flex items-end gap-2 bg-muted/30 rounded-md p-2.5">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="cp-stage">基于哪个阶段的对话生成？</Label>
                <Select value={selectedStageId} onValueChange={setSelectedStageId}>
                  <SelectTrigger id="cp-stage">
                    <SelectValue placeholder="选择阶段" />
                  </SelectTrigger>
                  <SelectContent>
                    {stagesWithConversation.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {ROLE_LABEL[s.workRole] ?? s.workRole}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void handleGenerate()}
                disabled={generating || !selectedStageId}
              >
                {generating ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 mr-1" />
                )}
                {generating ? "生成中…" : "重新生成"}
              </Button>
            </div>
          )}
          {generating && !generateError && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> AI 正在根据对话记录自动生成检查点草稿…
            </p>
          )}
          {generateError && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{generateError}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="cp-title">标题 *</Label>
            <Input
              id="cp-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：前端组件 v1 完成，准备交给后端联调"
            />
          </div>
          {(
            [
              ["goal", "目标（Goal）", "这个检查点要达成什么"],
              ["completedSummary", "已完成（Completed Summary）", "到现在为止做了什么"],
              ["currentContext", "当前上下文（Current Context）", "下一个角色需要知道的关键背景"],
              ["decisions", "决策记录（Decisions）", "为什么这么选、放弃了哪些方案"],
              ["failedAttempts", "失败尝试（Failed Attempts）", "试过但行不通的路"],
              ["blockers", "阻塞项（Blockers）", "当前卡在哪"],
              ["nextSteps", "下一步（Next Steps）", "下一个角色具体做什么"],
              ["doNotRepeat", "禁止重复（Do Not Repeat）", "绝对不要再做的事"],
              ["acceptanceCriteria", "验收标准（Acceptance Criteria）", "怎么算「做完了」"],
            ] as const
          ).map(([key, label, ph]) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`cp-${key}`}>{label}</Label>
              <Textarea
                id={`cp-${key}`}
                value={
                  key === "goal" ? goal :
                  key === "completedSummary" ? completedSummary :
                  key === "currentContext" ? currentContext :
                  key === "decisions" ? decisions :
                  key === "failedAttempts" ? failedAttempts :
                  key === "blockers" ? blockers :
                  key === "nextSteps" ? nextSteps :
                  key === "doNotRepeat" ? doNotRepeat :
                  acceptanceCriteria
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (key === "goal") setGoal(v);
                  else if (key === "completedSummary") setCompletedSummary(v);
                  else if (key === "currentContext") setCurrentContext(v);
                  else if (key === "decisions") setDecisions(v);
                  else if (key === "failedAttempts") setFailedAttempts(v);
                  else if (key === "blockers") setBlockers(v);
                  else if (key === "nextSteps") setNextSteps(v);
                  else if (key === "doNotRepeat") setDoNotRepeat(v);
                  else setAcceptanceCriteria(v);
                }}
                placeholder={ph}
                rows={2}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving || !title.trim()}>
            {saving ? "保存中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============ 检查点详情对话框 ============

function CheckpointDetailDialog({
  checkpoint,
  open,
  onOpenChange,
}: {
  checkpoint: Checkpoint | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  if (!checkpoint) return null;
  const fields: Array<[string, string]> = [
    ["目标（Goal）", checkpoint.goal ?? ""],
    ["已完成（Completed Summary）", checkpoint.completedSummary ?? ""],
    ["当前上下文（Current Context）", checkpoint.currentContext ?? ""],
    ["决策记录（Decisions）", checkpoint.decisions ?? ""],
    ["失败尝试（Failed Attempts）", checkpoint.failedAttempts ?? ""],
    ["阻塞项（Blockers）", checkpoint.blockers ?? ""],
    ["下一步（Next Steps）", checkpoint.nextSteps ?? ""],
    ["禁止重复（Do Not Repeat）", checkpoint.doNotRepeat ?? ""],
    ["验收标准（Acceptance Criteria）", checkpoint.acceptanceCriteria ?? ""],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{checkpoint.title}</DialogTitle>
        </DialogHeader>
        <div className="text-xs text-muted-foreground">创建于 {formatTime(checkpoint.createdAt)}</div>
        <div className="space-y-3 text-sm">
          {fields.map(([label, value]) => (
            <div key={label} className="space-y-1">
              <div className="font-medium">{label}</div>
              <div className="text-muted-foreground whitespace-pre-wrap">
                {value || <span className="italic">（未填）</span>}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============ 生成接力包对话框 ============

function GenerateHandoffDialog({
  open,
  onOpenChange,
  checkpoint,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  checkpoint: Checkpoint | null;
  onCreated: () => void;
}) {
  const [targetRole, setTargetRole] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    if (!checkpoint || !targetRole) return;
    setSaving(true);
    setError(null);
    try {
      await dbHandoffs.generate(checkpoint.id, targetRole);
      setTargetRole("");
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>生成接力包</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {error && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}
          {checkpoint && (
            <div className="text-xs text-muted-foreground">
              原检查点：<span className="font-medium text-foreground">{checkpoint.title}</span>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>目标角色</Label>
            <Select value={targetRole} onValueChange={setTargetRole}>
              <SelectTrigger>
                <SelectValue placeholder="选择下一个接手的工作角色" />
              </SelectTrigger>
              <SelectContent>
                {WORK_ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}（{r.description}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="text-xs text-muted-foreground">
            接力包会把检查点所有字段拼成 markdown，存一条 handoff_packets 记录。
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void handleGenerate()} disabled={saving || !targetRole}>
            {saving ? "生成中…" : "生成"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============ 接力包详情对话框 ============

function HandoffDetailDialog({
  packet,
  open,
  onOpenChange,
}: {
  packet: HandoffPacket | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  if (!packet) return null;
  const roleLabel = ROLE_LABEL[packet.targetRole] ?? packet.targetRole;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>接力包 → {roleLabel}</DialogTitle>
        </DialogHeader>
        <div className="text-xs text-muted-foreground">生成于 {formatTime(packet.createdAt)}</div>
        <pre className="bg-muted rounded-md p-3 text-xs whitespace-pre-wrap break-words font-mono">
          {packet.content}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

// ============ 详情页主组件 ============

export interface ProjectDetailPageProps {
  projectId: string;
  onBack: () => void;
}

export function ProjectDetailPage({ projectId, onBack }: ProjectDetailPageProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [stages, setStages] = useState<ProjectStage[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [templateRoles, setTemplateRoles] = useState<ProjectTemplateRole[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffPacket[]>([]);
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const [createCpOpen, setCreateCpOpen] = useState(false);
  const [viewCp, setViewCp] = useState<Checkpoint | null>(null);
  const [genCp, setGenCp] = useState<Checkpoint | null>(null);
  const [viewHandoff, setViewHandoff] = useState<HandoffPacket | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const [p, s, m, c, cp, hf] = await Promise.all([
        dbProjects.getById(projectId),
        dbStages.listByProject(projectId),
        dbModels.listEnabled(),
        dbCredentials.list(),
        dbCheckpoints.listByProject(projectId),
        dbHandoffs.listByProject(projectId),
      ]);
      if (!p) {
        setLoadError("项目不存在");
        return;
      }
      setProject(p);
      setStages(s);
      setModels(m);
      setCredentials(c);
      setCheckpoints(cp);
      setHandoffs(hf);
      // 项目基于模板时，把模板的"角色→fallback 模型"映射加载进来，
      // 阶段对话失败时按 stage.workRole 找 fallback
      if (p.templateId) {
        const roles = await dbTemplateRoles.listByTemplate(p.templateId);
        setTemplateRoles(roles);
      } else {
        setTemplateRoles([]);
      }
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "加载失败");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const modelMap = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  const credentialMap = useMemo(
    () => new Map(credentials.map((c) => [c.providerId, c])),
    [credentials],
  );

  async function startStage(stage: ProjectStage) {
    if (!project) return;
    await dbStages.update(stage.id, { status: "running" });
    await dbProjects.update(project.id, {
      currentStage: stage.workRole,
      status: "active",
    });
    await load();
    setOpenStageId(stage.id);
  }

  async function completeStage(stage: ProjectStage) {
    await dbStages.update(stage.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    await load();
  }

  async function failStage(stage: ProjectStage) {
    await dbStages.update(stage.id, { status: "failed" });
    await load();
  }

  async function pauseProject() {
    if (!project) return;
    await dbProjects.update(project.id, { status: "paused" });
    await load();
  }

  async function resumeProject() {
    if (!project) return;
    await dbProjects.update(project.id, { status: "active" });
    await load();
  }

  async function completeProject() {
    if (!project) return;
    await dbProjects.update(project.id, {
      status: "completed",
      currentStage: "completed",
    });
    await load();
  }

  async function deleteCheckpoint(id: string) {
    if (!confirm("删除这个检查点？关联的接力包也会一起删。")) return;
    await dbCheckpoints.delete(id);
    await load();
  }

  if (loadError) {
    return (
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="w-3.5 h-3.5 mr-1" /> 返回项目列表
        </Button>
        <Alert variant="destructive">
          <AlertDescription>加载失败：{loadError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> 加载中…
      </div>
    );
  }

  const totalCost =
    stages.reduce((s, st) => s + st.cost, 0) +
    (project.status === "completed" ? 0 : 0);
  const totalTokens = stages.reduce(
    (s, st) => s + st.inputTokens + st.outputTokens,
    0,
  );

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* 顶部状态栏 */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
            <ArrowLeft className="w-3.5 h-3.5 mr-1" /> 返回
          </Button>
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          {project.description && (
            <p className="text-sm text-muted-foreground">{project.description}</p>
          )}
          <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1">
            <Badge variant={PROJECT_STATUS_VARIANT[project.status] ?? "outline"}>
              {project.status}
            </Badge>
            <span>当前阶段：{ROLE_LABEL[project.currentStage] ?? project.currentStage}</span>
            {project.template?.name && <span>模板：{project.template.name}</span>}
            <span>总成本：{formatCost(totalCost)}</span>
            <span>总 token：{totalTokens.toLocaleString("zh-CN")}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {project.status === "active" ? (
            <Button variant="outline" size="sm" onClick={() => void pauseProject()}>
              <Pause className="w-3.5 h-3.5 mr-1" /> 暂停
            </Button>
          ) : project.status === "paused" ? (
            <Button variant="outline" size="sm" onClick={() => void resumeProject()}>
              <Play className="w-3.5 h-3.5 mr-1" /> 恢复
            </Button>
          ) : null}
          {project.status !== "completed" && (
            <Button size="sm" onClick={() => void completeProject()}>
              <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> 标记完成
            </Button>
          )}
        </div>
      </div>

      {/* 阶段时间线 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Clock className="w-4 h-4" /> 阶段时间线（{stages.length}）
        </h2>
        {stages.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            还没有阶段。先去「项目模板」页基于模板新建项目，会自动生成阶段。
          </Card>
        ) : (
          <div className="space-y-2">
            {stages.map((st) => {
              const m = modelMap.get(st.modelId);
              const isOpen = openStageId === st.id;
              const cred = m ? credentialMap.get(m.providerId) : undefined;
              const canChat = !!(m && cred);
              return (
                <Card key={st.id} className="overflow-hidden">
                  <div className="p-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {st.status === "completed" ? (
                        <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                      ) : st.status === "running" || st.status === "active" ? (
                        <Loader2 className="w-4 h-4 text-blue-600 animate-spin shrink-0" />
                      ) : st.status === "failed" ? (
                        <Circle className="w-4 h-4 text-destructive shrink-0" />
                      ) : (
                        <Circle className="w-4 h-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="font-medium">
                        {ROLE_LABEL[st.workRole] ?? st.workRole}
                      </span>
                      {m && (
                        <span className="text-xs text-muted-foreground truncate">
                          {m.displayName ?? m.name}
                        </span>
                      )}
                      <Badge variant={STAGE_STATUS_VARIANT[st.status] ?? "outline"} className="text-xs">
                        {STAGE_STATUS_LABEL[st.status] ?? st.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                      <span>↑{st.inputTokens.toLocaleString("zh-CN")} ↓{st.outputTokens.toLocaleString("zh-CN")}</span>
                      <span>{formatCost(st.cost)}</span>
                      <div className="flex gap-1">
                        {st.status === "pending" && (
                          <Button size="sm" variant="outline" onClick={() => void startStage(st)}>
                            开始
                          </Button>
                        )}
                        {(st.status === "running" || st.status === "active") && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setOpenStageId(isOpen ? null : st.id)}
                              disabled={!canChat}
                              title={!canChat ? "缺少模型或凭证" : ""}
                            >
                              <MessageSquare className="w-3 h-3 mr-1" />
                              {isOpen ? "收起对话" : "查看对话"}
                            </Button>
                            <Button size="sm" onClick={() => void completeStage(st)}>
                              标记完成
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => void failStage(st)}>
                              失败
                            </Button>
                          </>
                        )}
                        {st.status === "completed" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setOpenStageId(isOpen ? null : st.id)}
                            disabled={!canChat}
                          >
                            <MessageSquare className="w-3 h-3 mr-1" />
                            {isOpen ? "收起对话" : "查看对话"}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                  {st.errorMessage && (
                    <div className="px-3 pb-2 text-xs text-destructive">{st.errorMessage}</div>
                  )}
                  {isOpen && canChat && m && cred && (
                    <StageConversationLoader
                      stage={st}
                      model={m}
                      credential={cred}
                      models={models}
                      credentials={credentials}
                      templateRoles={templateRoles}
                    />
                  )}
                  {isOpen && !canChat && (
                    <div className="border-t p-3 text-xs text-muted-foreground">
                      这个阶段没有可用模型或凭证，无法发起对话
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* 检查点 */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">检查点（{checkpoints.length}）</h2>
          <Button size="sm" variant="outline" onClick={() => setCreateCpOpen(true)}>
            <Plus className="w-3.5 h-3.5 mr-1" /> 创建检查点
          </Button>
        </div>
        {checkpoints.length === 0 ? (
          <Card className="p-6 text-center text-xs text-muted-foreground">
            还没有检查点。检查点是"给下一个 AI 看的工作交接备忘录"
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {checkpoints.map((cp) => (
              <Card key={cp.id} className="p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium text-sm truncate">{cp.title}</div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive h-6 w-6 p-0 shrink-0"
                    onClick={() => void deleteCheckpoint(cp.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground">{formatTime(cp.createdAt)}</div>
                {cp.goal && (
                  <div className="text-xs line-clamp-2 text-muted-foreground">{cp.goal}</div>
                )}
                <div className="flex gap-1.5 pt-1">
                  <Button size="sm" variant="outline" onClick={() => setViewCp(cp)}>
                    查看
                  </Button>
                  <Button size="sm" onClick={() => setGenCp(cp)}>
                    生成接力包
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* 接力包 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">接力包（{handoffs.length}）</h2>
        {handoffs.length === 0 ? (
          <Card className="p-6 text-center text-xs text-muted-foreground">
            还没有接力包。从检查点卡片点「生成接力包」开始
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {handoffs.map((hf) => (
              <Card key={hf.id} className="p-3 space-y-1">
                <div className="font-medium text-sm">
                  → {ROLE_LABEL[hf.targetRole] ?? hf.targetRole}
                </div>
                <div className="text-xs text-muted-foreground">{formatTime(hf.createdAt)}</div>
                <Button size="sm" variant="outline" onClick={() => setViewHandoff(hf)}>
                  查看内容
                </Button>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* 对话框们 */}
      <CreateCheckpointDialog
        open={createCpOpen}
        onOpenChange={setCreateCpOpen}
        projectId={projectId}
        stages={stages}
        models={models}
        credentials={credentials}
        onCreated={() => void load()}
      />
      <CheckpointDetailDialog
        checkpoint={viewCp}
        open={viewCp !== null}
        onOpenChange={(v) => !v && setViewCp(null)}
      />
      <GenerateHandoffDialog
        open={genCp !== null}
        onOpenChange={(v) => !v && setGenCp(null)}
        checkpoint={genCp}
        onCreated={() => void load()}
      />
      <HandoffDetailDialog
        packet={viewHandoff}
        open={viewHandoff !== null}
        onOpenChange={(v) => !v && setViewHandoff(null)}
      />
    </div>
  );
}

// ============ 阶段对话懒加载容器：拿到 apiKey 后才挂 StageChat ============

function StageConversationLoader({
  stage,
  model,
  credential,
  models,
  credentials,
  templateRoles,
}: {
  stage: ProjectStage;
  model: Model;
  credential: ApiCredential;
  models: Model[];
  credentials: ApiCredential[];
  templateRoles: ProjectTemplateRole[];
}) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [fallback, setFallback] = useState<{
    model: Model;
    credential: ApiCredential;
    apiKey: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        // 找/建 conversation：title = `${projectId}:${stageId}`
        // 用 projectId + stageId 组合做标题，避免重复
        const convs = await dbConversations.list();
        const title = `${stage.projectId}:${stage.id}`;
        let conv = convs.find((c) => c.projectId === stage.projectId && c.title === title);
        if (!conv) {
          conv = await dbConversations.create({
            title,
            defaultModelId: stage.modelId,
            projectId: stage.projectId,
          });
        }
        setConversationId(conv.id);

        const key = await getApiKey(credential.id);
        if (!key) {
          setError("API Key 未找到，请重新添加凭证");
          return;
        }
        setApiKey(key);

        // 按 stage.workRole 在模板角色清单里找 fallback 模型
        const role = templateRoles.find((r) => r.workRole === stage.workRole);
        if (role && role.fallbackModelId && role.fallbackModelId !== stage.modelId) {
          const fbModel = models.find((m) => m.id === role.fallbackModelId);
          if (fbModel) {
            const fbCred = credentials.find((c) => c.providerId === fbModel.providerId);
            if (fbCred) {
              const fbKey = await getApiKey(fbCred.id);
              if (fbKey) {
                setFallback({ model: fbModel, credential: fbCred, apiKey: fbKey });
              }
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载失败");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.id]);

  if (error) {
    return (
      <div className="border-t p-3 text-xs text-destructive">{error}</div>
    );
  }
  if (!conversationId || !apiKey) {
    return (
      <div className="border-t p-3 text-xs text-muted-foreground flex items-center">
        <Loader2 className="w-3 h-3 mr-2 animate-spin" /> 准备对话环境…
      </div>
    );
  }
  return (
    <StageChat
      stage={stage}
      model={model}
      credential={credential}
      apiKey={apiKey}
      conversationId={conversationId}
      fallback={fallback}
    />
  );
}