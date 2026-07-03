// ChatPage - 重构为 "Cosmic Cyber" 视觉风格
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePanelResize } from "@/components/ui/resize-handle";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { desktopDir } from "@tauri-apps/api/path";
import { type ToolCallView } from "@/lib/work-artifact-views";
import { deriveChainNodeGraph } from "@/components/work-panel/derive-chain-node-graph";
import { ensureModelLimitsLoaded } from "@/lib/llm/model-limits";
import { type ModelListItem } from "@/lib/api";
import { conversations as dbConversations, messages as dbMessages, toolExecutions, workflowRuns, intentLearning, getRoleBindingsForConversation, projects as dbProjects, projectMemories as dbProjectMemories, usageEvents, type Conversation } from "@/lib/db";
import { prepareWorkspaceToolRuntime, type WorkspaceToolRuntime } from "@/lib/llm/workspace-tool-runtime";
import { getApiKey } from "@/lib/keystore";
import { streamWithFallback, toModelEndpoint, type ModelEndpoint, type StreamUsage } from "@/lib/llm/chat-fallback";
import { runDynamicDebate } from "@/lib/llm/debate-engine";
import { realRunRole } from "@/lib/llm/debate-runner";
import { archiveDynamicDebateResult } from "@/lib/llm/debate-persistence";
import { isCliProviderType } from "@/lib/llm/cli-protocol";
import { classifyMessageComplexity } from "@/lib/llm/message-router";
import { shouldAutoRunChain, shouldRunBackgroundOrchestration } from "@/lib/llm/orchestration-gating";
import { buildRolePerformanceScoresFromUsageRows } from "@/lib/llm/model-performance-scoring";
import { isPureSingleModelModeEnabled, isSmartRoutingEnabled, usePermissionModeSetting } from "@/lib/app-settings";
import { shouldExposeWriteTools, impliesWriteIntent } from "@/lib/llm/tool-permission-policy";
import { enableWorkspaceProtection } from "@/lib/llm/tools/git-snapshot";
import { lookupCache, writeCache } from "@/lib/llm/semantic-cache";
import { buildProjectMemoryPreamble } from "@/lib/llm/context-preamble";
import { buildWorkspacePreamble } from "@/lib/llm/workspace-context";
import { createCodeTaskWorkflowSnapshot } from "@/lib/workflow/code-task-template";
import { classifyTurnIntentWithJudge } from "@/lib/workflow/intent-judge";
import { isExplicitDebateRequest } from "@/lib/workflow/intent-classifier";
import { detectIntentCorrection, intentActionLabel } from "@/lib/workflow/intent-feedback";
import type { IntentExample } from "@/lib/workflow/semantic-intent-router";
import { applyTurnIntentDecision, completeCurrentWorkflowNode } from "@/lib/workflow/reducer";
import type { TurnIntentDecision, WorkflowSnapshot } from "@/lib/workflow/types";
import { evaluateHarness, isClean, detectIntentNoToolCall, type HarnessVerdict } from "@/lib/llm/harness/feedback";
import { runChain as runChainImpl } from "@/lib/llm/chain-runner";
import { type RoleId } from "@/lib/llm/orchestrator";

import { classifyLlmError } from "@/lib/llm/error-classifier";
import { type Attachment } from "@/lib/llm/attachments";
import { retrieveCrossProjectMemoriesForPrompt } from "@/lib/memory/retrieval";
import { createOptimisticUserTurn } from "@/pages/chat/optimistic-turn";
import { getActiveAssistantModelLabel } from "@/pages/chat/streaming-status";
import {
  planNodes,
  resolveOrchestration,
  diffOrchestration,
  currentNode,
  pinModelToNode,
  pickOrchestratorModel,
  serializeOrchestration,
  parseOrchestration,
  computeChain,
  withChainPlan,
  shouldSkipOrchestrationUpdate,
  type OrchestrationTurn,
} from "@/lib/llm/orchestrator";
import { getLanguageModel } from "@/lib/llm/provider-factory";
import { ChatTranscript } from "@/pages/chat/ChatTranscript";
import { ChatHeader } from "@/pages/chat/ChatHeader";
import { ChatInputDock } from "@/pages/chat/ChatInputDock";
import { ChatWorkPanel } from "@/pages/chat/ChatWorkPanel";
import {
  applyChainHarnessWarnings,
  buildChainPath,
  completeChainRoleMessage,
  createChainFinishMessage,
  createChainRoleMessage,
  createChainStartMessage,
  updateChainRoleContent,
} from "@/pages/chat/chain-messages";
import { dbMessagesToChat, filterReadRecordsSince } from "@/pages/chat/history";
import { buildDebateParticipants } from "@/pages/chat/debate-participants";
import { buildDebateTopic, formatDebateResultMessage } from "@/pages/chat/debate-result";
import { buildMainChatModelChain } from "@/pages/chat/model-chain";
import { buildOrchestrationReceipt } from "@/pages/chat/orchestration-receipt";
import { applyPromptCompression } from "@/pages/chat/prompt-compression";
import { buildChatPromptMessages } from "@/pages/chat/prompt-messages";
import { decideStreamRetry } from "@/pages/chat/stream-retry";
import { createStreamingTurnCallbacks, createStreamingTurnState } from "@/pages/chat/streaming-callbacks";
import type { ChatMessage, PendingSend } from "@/pages/chat/types";
import { useChatAttachments } from "@/pages/chat/useChatAttachments";
import { useChatInput } from "@/pages/chat/useChatInput";
import { useModelSelection } from "@/pages/chat/useModelSelection";
import { useOrchestration } from "@/pages/chat/useOrchestration";
import { useWorkPanel } from "@/pages/chat/useWorkPanel";

type ChatUsage = StreamUsage;

// 工具权限三档（read/confirm/auto）：持久化在 app-settings 的 localStorage，
// 用户的习惯跨会话保留，重启也不被重置回只读。PermissionMode 类型从 app-settings 导出，
// 见 @/lib/app-settings（hook 也从那里导入）
interface ChatPageProps {
  /** 当前是否停留在聊天页（所有页面常驻挂载，靠这个判断"切回来了"以刷新模型列表） */
  active?: boolean;
}

export function ChatPage({ active = true }: ChatPageProps = {}) {
  const { t } = useTranslation();
  const { confirm, alert } = useConfirm();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationList, setConversationList] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamElapsedMs, setStreamElapsedMs] = useState(0);
  // 消息队列：模型回复时用户还能继续发，发的句子排队，模型回完自动串行处理（不打断、不中断工作）
  const [pendingQueue, setPendingQueue] = useState<PendingSend[]>([]);
  const drainingRef = useRef(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  // Harness 闭环：检测到模型编造、正在让它自查重答时的提示条
  const [harnessNotice, setHarnessNotice] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<ChatUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = usePermissionModeSetting();
  // 镜像当前会话 id，供后台编排回调判断"用户是否已切走会话"（避免回执落到错的会话）
  const conversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
  const workPanel = usePanelResize({ initial: 320, min: 240, max: 560, edge: "left" });

  const abortRef = useRef<AbortController | null>(null);
  const pendingRoutingDecisionRef = useRef<{
    prompt: string;
    baselineModelId: string;
    baselineModelName: string;
    baselineProviderType?: string | null;
    actualModelId: string;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // hook F：输入 + 滚动机制（scrollRef/inputAreaRef/inputAreaH/stickToBottomRef/
  // showJumpToBottom + scrollToBottom + ResizeObserver + 滚动监听 effect）
  // messages 变化触发的自动滚底 effect 留在协调层（归 hook C 流式，本阶段不搬）
  const {
    scrollRef,
    inputAreaRef,
    inputAreaH,
    stickToBottomRef,
    showJumpToBottom,
    scrollToBottom,
  } = useChatInput();

  // hook D：编排 + 对弈链 + 工作流快照（useReducer 重构）
  // 必须在 hook B 之前调用——hook B 依赖 orchestrationRef + applyOrchestration
  const {
    orchestration,
    chainExecutedRoles,
    chainSkippedRoles,
    chainAbortedRole,
    chainRunning,
    workflowSnapshot,
    setChainExecutedRoles,
    setChainSkippedRoles,
    setChainAbortedRole,
    setChainRunning,
    orchestrationRef,
    workflowSnapshotRef,
    chainAbortRef,
    applyOrchestration,
    applyWorkflowSnapshot,
    loadWorkflowForConversation,
  } = useOrchestration({ conversationId });

  // hook B：模型选择。所有 deps（conversationId/messages/orchestrationRef/inputRef/
  // pendingRoutingDecisionRef/applyOrchestration/setSwitchNotice）都在上面声明完后才能调
  const {
    availableModels,
    credentials,
    selectedModelId,
    setSelectedModelId,
    handleModelChange,
    handleSmartPick,
    loadModelsAndCreds,
  } = useModelSelection({
    conversationId,
    messages,
    orchestrationRef,
    inputRef,
    pendingRoutingDecisionRef,
    active,
    applyOrchestration,
    setSwitchNotice,
    // 用户手动切模型时同步会话默认模型到 conversationList + 写库
    onConversationDefaultModelChanged: (newId) => {
      setConversationList((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, defaultModelId: newId } : c)),
      );
      if (conversationId) void dbConversations.setDefaultModelId(conversationId, newId).catch(() => {});
    },
    alert,
    t,
  });

  // Harness 闭环：按时间窗口取本轮真实 read 记录，避免整段会话的旧工具审计污染当前判断。
  async function evalHarnessForConversation(
    convId: string | null,
    content: string,
    sinceIso: string | null,
  ): Promise<HarnessVerdict | null> {
    if (!convId || !content.trim()) return null;
    try {
      const all = await toolExecutions.listByConversation(convId);
      applyToolExecutionRows(all);
      const readRecords = filterReadRecordsSince(all, sinceIso);
      return evaluateHarness(content, readRecords);
    } catch {
      return null;
    }
  }

  // 新内容到达时：只有用户仍贴在底部才自动滚，否则纹丝不动（不跟用户抢滚动条）
  // messages 变化驱动——归 hook C 流式，本阶段不搬
  useEffect(() => {
    if (scrollRef.current && stickToBottomRef.current) {
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

  function pickConversationModelId(
    conv: Conversation | null | undefined,
    models: ModelListItem[],
    fallbackId: string,
  ): string {
    const preferredId = conv?.defaultModelId ?? null;
    if (preferredId && models.some((m) => m.id === preferredId)) return preferredId;
    if (fallbackId && models.some((m) => m.id === fallbackId)) return fallbackId;
    return models[0]?.id ?? "";
  }

  // 进页面就预热 models.dev 输出上限表，让首条消息也能按模型真实上限精确给预算
  useEffect(() => {
    void ensureModelLimitsLoaded();
  }, []);

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
        setSelectedModelId(pickConversationModelId(activeConv, ml, activeConv.defaultModelId ?? ""));
        const hist = await dbMessages.listByConversation(activeConv.id);
        setMessages(dbMessagesToChat(hist, ml));
        try {
          applyToolExecutionRows(await toolExecutions.listByConversation(activeConv.id));
        } catch {
          clearToolExecutionViews();
        }
        try {
          applyOrchestration(parseOrchestration(await dbConversations.getOrchestration(activeConv.id)));
        } catch {
          applyOrchestration(null);
        }
        await loadWorkflowForConversation(activeConv.id);
        setLoadError(null);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : t("chat.loadError"));
      }
    })();
  }, []);

  // hook E：右侧工作面板（workspace + 工具确认流 + artifacts/toolCallViews/panelOpen）
  const {
    panelOpen,
    workspacePath,
    protectedWorkspaces,
    artifacts,
    toolCallViews,
    pendingConfirm,
    setPanelOpen,
    setWorkspacePath,
    setProtectedWorkspaces,
    applyToolExecutionRows,
    clearToolExecutionViews,
    requestConfirm,
    resolveConfirm,
    bindWorkspace,
    chooseWorkspace,
    clearWorkspace,
  } = useWorkPanel({
    conversationId,
    // 改会话工作文件夹时同步 conversationList（不写库，hook E 内部写）
    onConversationWorkspaceChanged: (path) => {
      setConversationList((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, workspacePath: path } : c)),
      );
    },
    isStreaming,
    t,
  });

  // hook D：编排 + 对弈链 + 工作流快照（useReducer 重构）已上移到 hook F 之后

  const {
    draftAttachments,
    handlePaste,
    removeAttachment,
    setDraftAttachments,
  } = useChatAttachments({ t, bindWorkspace, setStreamError });

  async function handleNewChat() {
    // 修复（2026-07-03，用户反馈"点新建对话没反应"）：这里原来是 isStreaming 时直接
    // return，如果 isStreaming 因为任何原因卡在 true（比如底层 provider 卡死不理
    // AbortSignal，或者本轮还没走到统一安全网 finally），用户会永远点不动"新建对话"，
    // 且没有任何提示——跟 handleStop（停止键）"权威停止：不管底层卡没卡死，直接把 UI
    // 拉回空闲态"是同一个思路：新建对话本身就是"我要放弃当前这轮，另起一个"的明确意图，
    // 应该强制中断当前流，而不是被它卡住拒绝响应。
    if (isStreaming) handleStop();
    try {
      const conv = await dbConversations.create({ title: t("chat.untitledChat"), defaultModelId: selectedModelId || null, projectId: null });
      setConversationList((prev) => [conv, ...prev]);
      setConversationId(conv.id);
      setWorkspacePath(null);
      setSelectedModelId(pickConversationModelId(conv, availableModels, selectedModelId));
      setMessages([]);
      clearToolExecutionViews();
      applyOrchestration(null);
      applyWorkflowSnapshot(null);
      setPendingQueue([]);
      setStreamError(null);
      setSwitchNotice(null);
      setCacheNotice(null);
    } catch (err) {
      console.error("[handleNewChat] failed to create conversation", err);
      setStreamError(t("chat.newChatFailed"));
    }
  }

  async function switchConversation(id: string) {
    if (id === conversationId) return;
    // 修复（2026-07-03）：同 handleNewChat——切换对话也是"放弃当前这轮"的明确意图，
    // isStreaming 卡住时应该强制停止而不是拒绝响应。
    if (isStreaming) handleStop();
    const nextConv = conversationList.find((c) => c.id === id) ?? null;
    setConversationId(id);
    setWorkspacePath(nextConv?.workspacePath ?? null);
    setSelectedModelId((prev) => pickConversationModelId(nextConv, availableModels, prev));
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
    // 加载该会话的历史工具执行 → 派生工件（切回旧会话能看到之前的产出物）
    try {
      applyToolExecutionRows(await toolExecutions.listByConversation(id));
    } catch {
      clearToolExecutionViews();
    }
    try {
      applyOrchestration(parseOrchestration(await dbConversations.getOrchestration(id)));
    } catch {
      applyOrchestration(null);
    }
    await loadWorkflowForConversation(id);
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
      setSelectedModelId(pickConversationModelId(conv, availableModels, selectedModelId));
      setMessages([]);
      clearToolExecutionViews();
      applyOrchestration(null);
      applyWorkflowSnapshot(null);
      return;
    }
    setConversationList(remaining);
    if (id === conversationId) {
      const next = remaining[0]!;
      setConversationId(next.id);
      setWorkspacePath(next.workspacePath);
      setSelectedModelId((prev) => pickConversationModelId(next, availableModels, prev));
      try {
        const hist = await dbMessages.listByConversation(next.id);
        setMessages(dbMessagesToChat(hist, availableModels));
      } catch {
        setMessages([]);
      }
      try {
        applyToolExecutionRows(await toolExecutions.listByConversation(next.id));
      } catch {
        clearToolExecutionViews();
      }
      try {
        applyOrchestration(parseOrchestration(await dbConversations.getOrchestration(next.id)));
      } catch {
        applyOrchestration(null);
      }
      await loadWorkflowForConversation(next.id);
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

  // handleSend 拆 5 段（阶段 6 拆分）：主体只做协调 + 通用初始化；具体逻辑在 5 个 helper 内。
  // 共享变量通过闭包共享——5 个 helper 都定义在 handleSend 内部，直接访问 model/controller/convId 等。
  // 统一安全网：handleSend 内部分支很多，每加一条新分支都要记得在每个 return 前手动清 isStreaming，
  // 历史上已经漏过。把全部函数体包进一个 try/finally——finally 保证 isStreaming 一定会被兜底关掉。
  async function handleSend(text: string, attachments?: Attachment[]) {
    // 编排自动挡：当前节点已绑定模型 → 本轮就用它（上一轮后台编排已定好，零延迟）。
    // 直接走 setSelectedModelId 让 UI 跟上，但**不经 handleModelChange**——那是用户手动切的路径，
    // 会记 switched_up 负反馈；系统自己换的不能污染评分。
    const activeNode = currentNode(orchestrationRef.current);
    // leader 节点 = 闲聊/单次答疑/读文件这类，尊重用户当前手选的模型，编排不自动覆盖
    // （否则用户选了 minimax，编排会因 main_chat 静态分高把模型自动换成 agnes，瞎切）。
    // 只有 architect/frontend/backend/tester/reviewer/security/runner 这种"该换专业模型"的角色才用编排绑的模型。
    const nodeModelId = activeNode?.role === "leader" ? null : (activeNode?.modelId ?? null);
    // 阶段 F1：actor 维度 → 透传给 streamWithFallback → UsageEvent.role_kind
    // - leader 那跳（activeNode=null 或 role='leader'）→ 'leader'（review F1-5：必须显式 'leader'，不能 NULL）
    // - 其他角色节点（理论上不应该从这条主对话路径跑，但兜底）→ activeNode.role
    const actorRole = activeNode?.role ?? "leader";
    const effectiveId =
      nodeModelId && availableModels.some((m) => m.id === nodeModelId) ? nodeModelId : selectedModelId;
    const foundModel = availableModels.find((m) => m.id === effectiveId);
    if (!foundModel || isStreaming) return;
    // 收窄 model 为 ModelListItem（helper 闭包共享，避免每处重新 type guard）
    const model: ModelListItem = foundModel;
    const controller = new AbortController();
    abortRef.current = controller;
    const cleanupStoppedTurn = () => {
      setIsStreaming(false);
      if (abortRef.current === controller) abortRef.current = null;
    };
    const stopIfAborted = () => {
      if (!controller.signal.aborted) return false;
      cleanupStoppedTurn();
      return true;
    };
    setIsStreaming(true);
    setStreamError(null);
    setSwitchNotice(null);
    setCacheNotice(null);
    if (effectiveId !== selectedModelId) setSelectedModelId(effectiveId);

    // 共享 state（5 段 helper 都用）
    const routingDecision =
      pendingRoutingDecisionRef.current &&
      pendingRoutingDecisionRef.current.prompt === text &&
      pendingRoutingDecisionRef.current.actualModelId === model.id
        ? {
            baselineModelId: pendingRoutingDecisionRef.current.baselineModelId,
            baselineModelName: pendingRoutingDecisionRef.current.baselineModelName,
            baselineProviderType: pendingRoutingDecisionRef.current.baselineProviderType ?? null,
            actualModelId: pendingRoutingDecisionRef.current.actualModelId,
          }
        : null;
    pendingRoutingDecisionRef.current = null;
    // 首条消息：用它给会话自动命名
    const isFirstMessage = messages.length === 0;
    // v0.9 阶段7：这一回合是否启用 v2（查缓存/压缩/写缓存）——入口读一次，全程一致
    const smart = isSmartRoutingEnabled();
    // 纯净单模型模式（调试用）：入口读一次，全程一致——关掉意图裁判/后台编排/对弈自动触发/
    // 语义缓存/记忆检索/harness重答闭环，只留"发消息→选中模型直接回复"这条最基础链路。
    const pureMode = isPureSingleModelModeEnabled();
    const optimisticTurn = createOptimisticUserTurn<ChatMessage>({ messages, text, attachments });
    const userMsg: ChatMessage = optimisticTurn.userMsg;
    const newMessages: ChatMessage[] = [...messages, userMsg];
    let userId = userMsg.id;
    // 输入确认后先把用户气泡放进主对话；落库、意图判断、工具准备都可以慢慢做。
    stickToBottomRef.current = true;
    setMessages(newMessages);

    try {
      // ===== 段1: prepareTurn - 构建用户消息 + 落库 + 凭证/工具初始化 =====
      const prep = await prepareTurn();
      if (prep === null) return;

      // ===== 段2: maybeRunDebate - 对弈触发判断（return early 表示已执行对弈）=====
      if (await maybeRunDebate(prep)) return;

      // ===== 段3: tryCacheHit - 语义缓存命中（return early 表示命中跳过）=====
      if (await tryCacheHit(prep)) return;

      // ===== 段4: runStreamLoop - 流式循环 + harness + 缓存写 + 错误处理 =====
      await runStreamLoop(prep);

      // ===== 段5: postStreamOrchestration - 后台编排触发 =====
      await postStreamOrchestration(prep);
    } finally {
      // 统一安全网收尾：见函数顶部对应的 try 注释。任何分支 return/抛错，这里都会兜底关掉 isStreaming。
      cleanupStoppedTurn();
    }

    // ===== 段1 实现：prepareTurn =====
    async function prepareTurn() {
      const cred = credentials.find((c) => c.providerId === model.providerId);
      if (!cred) {
        setStreamError(t("chat.noCredential"));
        cleanupStoppedTurn();
        return null;
      }

      // CLI 引擎走本机订阅登录态，没有 API Key；API 直连才需要取 Key
      const primaryIsCli = isCliProviderType(model.provider?.type ?? "");
      const apiKey = primaryIsCli ? "" : ((await getApiKey(cred.id)) ?? "");
      if (stopIfAborted()) return null;
      if (!primaryIsCli && !apiKey) {
        setStreamError(t("chat.noApiKey"));
        cleanupStoppedTurn();
        return null;
      }
      let intentJudgeModel: ReturnType<typeof getLanguageModel> | null = null;
      if (!primaryIsCli && model.provider?.type) {
        try {
          intentJudgeModel = getLanguageModel(model.provider.type, model.name, apiKey, cred.baseUrl);
        } catch {
          intentJudgeModel = null;
        }
      }

      // 附件图片：只有 CLI 模型（claude/codex 本机）真不能传图，拦住提示换 API；
      // API 模型一律放行——支持看图的就直接处理，不支持的由 API 报错自然反馈，不硬编码名单
      const hasImage = attachments?.some((a) => a.kind === "image");
      if (hasImage && primaryIsCli) {
        setStreamError(t("chat.attachments.cliNoImage"));
        cleanupStoppedTurn();
        return null;
      }
      // 拖入的文件夹：绑定为 AI 的工作文件夹（本次工具调用直接用这个路径，不靠异步 state）
      const folderAtt = attachments?.find((a) => a.kind === "folder");
      if (folderAtt) setWorkspacePath(folderAtt.path);
      const effectiveWorkspace = folderAtt?.path ?? workspacePath;

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
      if (stopIfAborted()) return null;
      if (convId) {
        try {
          userId = (await dbMessages.create({ conversationId: convId, role: "user", content: text, attachments: attachments?.length ? JSON.stringify(attachments) : null })).id;
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
      if (stopIfAborted()) return null;

      // 把助手最终/部分回答落库（成功、缓存命中、停止、中断都不丢）
      const persistAssistant = (
        content: string,
        modelId: string | null,
        usage?: { inputTokens: number; outputTokens: number },
        kind?: ChatMessage["kind"],
      ) => {
        if (!convId || !content) return;
        void dbMessages
          .create({
            conversationId: convId,
            role: "assistant",
            content,
            modelId,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            kind: kind && kind !== "chat" ? kind : null,
          })
          .catch(() => {});
      };

      let turnWorkflowSnapshot = workflowSnapshotRef.current;
      let turnWorkflowRunId: string | null = turnWorkflowSnapshot?.runId ?? null;
      let shouldCompleteWorkflowNode = false;
      let turnIntentDecision: TurnIntentDecision | null = null;
      // 5.2 修复补丁（2026-07-02）：显式标记"意图裁判 LLM 这轮是否已经调用过"，
      // 不再靠 turnIntentDecision 是否为 null 隐式推断——用显式布尔量替代隐式契约。
      let intentJudgeCalledThisTurn = false;
      let workflowAdvancedThisTurn = false;
      // 纯净模式：跳过意图裁判整个环节，turnIntentDecision 保持 null，下面 cacheIntent 兜底。
      if (convId && !pureMode) {
        try {
          if (!turnWorkflowSnapshot) {
            const activeRun = await workflowRuns.getActiveByConversation(convId);
            turnWorkflowSnapshot = activeRun?.snapshot ?? null;
            if (turnWorkflowSnapshot) applyWorkflowSnapshot(turnWorkflowSnapshot);
          }

          let learnedExamples: IntentExample[] = [];
          try {
            const correction = detectIntentCorrection(text);
            if (correction) {
              await intentLearning.recordFeedback({
                userText: text,
                predictedAction: correction.predictedAction,
                correctedAction: correction.correctedAction,
                workflowState: turnWorkflowSnapshot?.currentNodeId ?? turnWorkflowSnapshot?.status ?? null,
                source: "user_text",
                reason: `用户明确纠正：不是${intentActionLabel(correction.predictedAction)}，而是${intentActionLabel(correction.correctedAction)}`,
              });
              await intentLearning.upsertExample({
                action: correction.correctedAction,
                text,
                explanation: `用户纠正过：这类表达应识别为${intentActionLabel(correction.correctedAction)}，不是${intentActionLabel(correction.predictedAction)}。`,
                source: "user_correction",
                confidence: correction.confidence,
                weight: 1.25,
                enabled: true,
              });
            }
            learnedExamples = (await intentLearning.listExamples({ enabledOnly: true })).map((example) => ({
              id: example.id,
              action: example.action,
              text: example.text,
              explanation: example.explanation,
              source: example.source,
              weight: example.weight,
              enabled: example.enabled,
            }));
          } catch {
            learnedExamples = [];
          }

          const decision = await classifyTurnIntentWithJudge({
            text,
            activeRun: turnWorkflowSnapshot,
            recentTurnIds: [userId],
            model: intentJudgeModel,
            learnedExamples,
          });
          turnIntentDecision = decision;
          intentJudgeCalledThisTurn = true;

          if (decision.action === "start_run") {
            const currentConversation = conversationList.find((c) => c.id === convId) ?? null;
            const runId = crypto.randomUUID();
            const snapshot = createCodeTaskWorkflowSnapshot({
              runId,
              conversationId: convId,
              projectId: currentConversation?.projectId ?? null,
              workspacePath: folderAtt?.path ?? workspacePath,
              objective: decision.patch?.objective ?? text,
              executionMode: decision.patch?.executionMode,
            });
            await workflowRuns.create({ conversationId: convId, projectId: currentConversation?.projectId ?? null, snapshot });
            turnWorkflowSnapshot = snapshot;
            turnWorkflowRunId = runId;
            shouldCompleteWorkflowNode = true;
            workflowAdvancedThisTurn = true;
            applyWorkflowSnapshot(snapshot);
          } else if (turnWorkflowSnapshot && decision.action !== "answer_only") {
            const nextSnapshot = applyTurnIntentDecision({ snapshot: turnWorkflowSnapshot, decision });
            await workflowRuns.saveSnapshot({
              runId: nextSnapshot.runId,
              snapshot: nextSnapshot,
              eventType: "workflow.intent_applied",
              eventPayload: { decision },
            });
            turnWorkflowSnapshot = nextSnapshot;
            turnWorkflowRunId = nextSnapshot.runId;
            shouldCompleteWorkflowNode = true;
            workflowAdvancedThisTurn = true;
            applyWorkflowSnapshot(nextSnapshot);
          } else if (turnWorkflowRunId) {
            await workflowRuns.appendEvent({
              workflowRunId: turnWorkflowRunId,
              conversationId: convId,
              eventType: "workflow.intent_observed",
              payload: { decision },
            });
          }
        } catch {
          // workflow 是辅助状态，失败不能阻断主对话。
        }
      }
      if (stopIfAborted()) return null;

      return {
        cred,
        primaryIsCli,
        apiKey,
        intentJudgeModel,
        folderAtt,
        effectiveWorkspace,
        convId,
        persistAssistant,
        turnWorkflowSnapshot,
        turnWorkflowRunId,
        shouldCompleteWorkflowNode,
        turnIntentDecision,
        intentJudgeCalledThisTurn,
        workflowAdvancedThisTurn,
      };
    }

    // ===== 段2 实现：maybeRunDebate =====
    async function maybeRunDebate(prep: Awaited<ReturnType<typeof prepareTurn>>): Promise<boolean> {
      if (!prep) return false;
      const {
        turnWorkflowSnapshot,
        turnWorkflowRunId,
        convId,
        primaryIsCli: _primaryIsCli,
        effectiveWorkspace,
        turnIntentDecision,
        workflowAdvancedThisTurn,
      } = prep;
      const currentWorkflowNode = turnWorkflowSnapshot?.nodes.find((n) => n.id === turnWorkflowSnapshot?.currentNodeId) ?? null;
      // 真对弈触发条件（新逻辑）：
      //  ① 用户这句明确要博弈（意图判定 debate，或原文含"博弈/对弈/PK/辩论/debate"）→ 直接跑真对弈，
      //     不要求有 run（对弈执行块对 snapshot 为 null 已全程守门，跑完只是跳过节点记账）；
      //  ② 或工作流刚好推进到 debate 节点。
      const explicitDebateRequest =
        turnIntentDecision?.patch?.debateRequested === true ||
        isExplicitDebateRequest(text);
      const shouldRunDebateTurn =
        !pureMode &&
        (explicitDebateRequest ||
          (currentWorkflowNode?.phase === "debate" &&
            !!turnWorkflowSnapshot?.intent.debateRequested &&
            workflowAdvancedThisTurn));
      if (!shouldRunDebateTurn) return false;

      // 协作链面板从 workflowSnapshot 派生「模型博弈」卡片。这里临时建一个 run 并标到 debate 节点，
      // 让面板渲染博弈卡片，同时让后面的完成/落库逻辑（需要 runId）一致工作。
      let activeSnapshot = turnWorkflowSnapshot;
      let activeRunId = turnWorkflowRunId;
      if (!activeSnapshot && convId) {
        try {
          const currentConversation = conversationList.find((c) => c.id === convId) ?? null;
          const adHocRunId = crypto.randomUUID();
          const base = createCodeTaskWorkflowSnapshot({
            runId: adHocRunId,
            conversationId: convId,
            projectId: currentConversation?.projectId ?? null,
            workspacePath: effectiveWorkspace,
            objective: text,
          });
          const debateSnapshot = applyTurnIntentDecision({
            snapshot: base,
            decision: {
              action: "continue_run",
              targetRunId: adHocRunId,
              confidence: 1,
              reason: "用户明确要求开始博弈",
              evidenceTurnIds: [],
              patch: { debateRequested: true },
            },
          });
          await workflowRuns.create({
            conversationId: convId,
            projectId: currentConversation?.projectId ?? null,
            snapshot: debateSnapshot,
          });
          activeSnapshot = debateSnapshot;
          activeRunId = adHocRunId;
          applyWorkflowSnapshot(debateSnapshot);
        } catch {
          // 建临时 run 失败不阻断博弈本身（只是协作链可能不出卡片）。
        }
      }

      const assistantId = crypto.randomUUID();
      // 6.3.1 修复（2026-07-02）：触发对弈前先推一条成本预警，让用户心理有数。
      // 真实规则见 debate-engine.ts runDynamicDebate：1 参与者=纯自审(1 次)；2 参与者=proposer 再当 judge(3 次)；3+ 参与者=1 主答+(N-2)评审+1 裁判=N 次。
      const estimatedParticipants = Math.min(Math.max(availableModels.length, 1), 4);
      const estimatedCallCount =
        estimatedParticipants <= 1 ? 1 : estimatedParticipants === 2 ? 3 : estimatedParticipants;
      const costNoteId = crypto.randomUUID();
      const costNoteMsg: ChatMessage = {
        id: costNoteId,
        role: "assistant",
        content: t("chat.debate.costWarning", { count: estimatedCallCount }),
        createdAt: new Date().toISOString(),
        modelLabel: t("chat.workPanel.dynamicModelPool"),
        kind: "system-notice",
      };
      const debateMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: t("chat.debate.running"),
        createdAt: new Date().toISOString(),
        modelLabel: t("chat.workPanel.dynamicModelPool"),
      };
      stickToBottomRef.current = true;
      setPanelOpen(true);
      setMessages([...newMessages, costNoteMsg, debateMsg]);
      setIsStreaming(true);
      setStreamError(null);
      setSwitchNotice(null);
      setCacheNotice(null);

      try {
        const participants = await buildDebateParticipants({
          primaryModel: model,
          availableModels,
          credentials,
          effectiveWorkspace,
          getApiKey,
          maxParticipants: 4,
        });
        if (participants.length === 0) {
          throw new Error(t("chat.debate.noParticipants"));
        }

        const topic = buildDebateTopic({ messages, userMessage: userMsg });
        const result = await runDynamicDebate({ topic, participants, maxParticipants: 4, signal: controller.signal }, realRunRole);
        const nameFor = (modelId: string) => {
          const found = availableModels.find((m) => m.id === modelId);
          return found?.displayName || found?.name || modelId;
        };
        const { content: finalContent, usage: totalUsage } = formatDebateResultMessage({
          result,
          participantCount: participants.length,
          modelNameFor: nameFor,
          t,
        });

        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: finalContent, usage: { ...totalUsage, toolCallCount: 0 } } : m)),
        );
        prep.persistAssistant(finalContent, result.rounds.at(-1)?.modelId ?? model.id, totalUsage);
        await archiveDynamicDebateResult({
          projectId: (convId ? conversationList.find((c) => c.id === convId)?.projectId : null) ?? null,
          result,
        });

        if (convId && activeSnapshot && activeRunId) {
          const nextWorkflow = completeCurrentWorkflowNode({
            snapshot: activeSnapshot,
            summary: result.finalSolution.slice(0, 1200),
          });
          await workflowRuns.saveSnapshot({
            runId: activeRunId,
            snapshot: nextWorkflow,
            eventType: "workflow.debate_completed",
            eventPayload: {
              participantModelIds: participants.map((p) => p.modelId),
              rounds: result.rounds.map((r) => ({ role: r.role, modelId: r.modelId })),
            },
          });
          applyWorkflowSnapshot(nextWorkflow);
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          const stoppedMessage = t("chat.stopped");
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: stoppedMessage } : m)),
          );
          if (convId && activeSnapshot && activeRunId) {
            const snap = activeSnapshot;
            const cancelledWorkflow: WorkflowSnapshot = {
              ...snap,
              status: "cancelled",
              nodes: snap.nodes.map((n) =>
                n.id === snap.currentNodeId ? { ...n, status: "skipped" } : n,
              ),
            };
            await workflowRuns.saveSnapshot({
              runId: activeRunId,
              snapshot: cancelledWorkflow,
              eventType: "workflow.debate_cancelled",
              eventPayload: { reason: "user_stopped" },
            }).catch(() => {});
            applyWorkflowSnapshot(cancelledWorkflow);
          }
          return true;
        }
        const message = err instanceof Error ? err.message : t("chat.debate.failed");
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: message } : m)),
        );
        prep.persistAssistant(message, null);
        setStreamError(message);
        if (convId && activeSnapshot && activeRunId) {
          const snap = activeSnapshot;
          const failedWorkflow: WorkflowSnapshot = {
            ...snap,
            status: "failed",
            nodes: snap.nodes.map((n) =>
              n.id === snap.currentNodeId ? { ...n, status: "failed" } : n,
            ),
          };
          await workflowRuns.saveSnapshot({
            runId: activeRunId,
            snapshot: failedWorkflow,
            eventType: "workflow.debate_failed",
            eventPayload: { message },
          }).catch(() => {});
          applyWorkflowSnapshot(failedWorkflow);
        }
      } finally {
        setIsStreaming(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
      return true;
    }

    // ===== 段3 实现：tryCacheHit =====
    async function tryCacheHit(prep: Awaited<ReturnType<typeof prepareTurn>>): Promise<boolean> {
      if (!prep) return false;
      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "", createdAt: new Date().toISOString(), modelLabel: model.displayName ?? model.name };
      // 用户主动发消息：强制贴底，这一轮回答自动跟随滚动
      stickToBottomRef.current = true;
      setMessages([...newMessages, assistantMsg]);
      setIsStreaming(true);
      setStreamError(null);
      setSwitchNotice(null);
      setCacheNotice(null);

      const taskRole = classifyMessageComplexity(text);
      const turnStartedAt = new Date().toISOString();

      // 缓存准入门：只对「没绑工作文件夹 + 纯问答意图」开放。
      const cacheWorkspace = prep.folderAtt?.path ?? workspacePath;
      // 5.2 修复补丁（2026-07-02）：防重复调用意图裁判 LLM 的判断改用显式 intentJudgeCalledThisTurn。
      const cacheIntent: TurnIntentDecision =
        pureMode
          ? { action: "answer_only", targetRunId: null, confidence: 1, reason: "pure-single-model-mode", evidenceTurnIds: [] }
          : prep.intentJudgeCalledThisTurn && prep.turnIntentDecision
            ? prep.turnIntentDecision
            : await classifyTurnIntentWithJudge({ text, activeRun: workflowSnapshotRef.current, model: prep.intentJudgeModel });
      const cacheEligible = !pureMode && smart && !cacheWorkspace && cacheIntent.action === "answer_only";

      // v0.9 阶段7：纯问答先查语义缓存——命中则秒回、0 成本、跳过 LLM
      if (cacheEligible) {
        try {
          const hit = await lookupCache(text);
          if (hit) {
            const days = Math.max(0, Math.floor(hit.ageMs / 86_400_000));
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: hit.responseText } : m)),
            );
            prep.persistAssistant(hit.responseText, model.id);
            setCacheNotice(t("chat.cacheHit", { days }));
            cleanupStoppedTurn();
            return true;
          }
        } catch {
          // 缓存查询失败不影响主流程，继续正常调模型
        }
      }

      // 把 assistantId/taskRole/turnStartedAt/cacheIntent/cacheEligible 挂到 prep 上给段4用
      (prep as any).assistantId = assistantId;
      (prep as any).assistantMsg = assistantMsg;
      (prep as any).taskRole = taskRole;
      (prep as any).turnStartedAt = turnStartedAt;
      (prep as any).cacheIntent = cacheIntent;
      (prep as any).cacheEligible = cacheEligible;
      return false;
    }

    // ===== 段4 实现：runStreamLoop =====
    async function runStreamLoop(prep: Awaited<ReturnType<typeof prepareTurn>>) {
      if (!prep) return;
      const assistantId = (prep as any).assistantId as string;
      const assistantMsg = (prep as any).assistantMsg as ChatMessage;
      const taskRole = (prep as any).taskRole;
      const turnStartedAt = (prep as any).turnStartedAt as string;
      const cacheIntent = (prep as any).cacheIntent as TurnIntentDecision;
      const cacheEligible = (prep as any).cacheEligible as boolean;
      const {
        cred,
        primaryIsCli,
        apiKey,
        effectiveWorkspace,
        convId,
        turnWorkflowSnapshot,
        turnWorkflowRunId,
        shouldCompleteWorkflowNode,
      } = prep;

      // 构造回退链：主模型在前，其余已启用模型按「主对话」能力分 + 优先换厂排序接在后面。
      let chain: ModelEndpoint[];
      try {
        chain = await buildMainChatModelChain({
          primaryModel: model,
          primaryCredential: cred,
          primaryApiKey: apiKey,
          primaryIsCli,
          availableModels,
          credentials,
          attachments,
          effectiveWorkspace,
          getApiKey,
          stopIfAborted,
        });
      } catch (err) {
        setStreamError(err instanceof Error ? err.message : t("chat.constructError"));
        cleanupStoppedTurn();
        return;
      }

      // 工作文件夹已绑 + 主模型非 CLI → 给模型挂文件工具
      let tools: WorkspaceToolRuntime["tools"];
      let workspacePreamble: string | null = null;
      let projectMemoryPreamble: string | null = null;
      let crossProjectPreamble: string | null = null;
      const includeWriteTools = shouldExposeWriteTools({
        text,
        permissionMode,
        decision: cacheIntent,
      });

      // V2 修复（2026-07-02）：消息明明想写/改文件，但没有任何工具能落地。
      if (
        impliesWriteIntent({ text, decision: cacheIntent }) &&
        (!effectiveWorkspace || permissionMode === "read")
      ) {
        const noticeMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: !effectiveWorkspace
            ? t("chat.writeGuardNotice.noWorkspace")
            : t("chat.writeGuardNotice.readOnly"),
          createdAt: new Date().toISOString(),
          modelLabel: t("chat.workPanel.dynamicModelPool"),
          kind: "system-notice",
        };
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantId);
          if (idx === -1) return [...prev, noticeMsg];
          return [...prev.slice(0, idx), noticeMsg, ...prev.slice(idx)];
        });
      }

      if (effectiveWorkspace) {
        const desktopPath = includeWriteTools ? await desktopDir().catch(() => null) : null;
        if (primaryIsCli) {
          workspacePreamble = await buildWorkspacePreamble(effectiveWorkspace, { includeWrite: includeWriteTools, desktopPath });
          if (stopIfAborted()) return;
        } else {
          const runtime = await prepareWorkspaceToolRuntime({
            workspacePath: effectiveWorkspace,
            includeWrite: includeWriteTools,
            conversationId: convId ?? undefined,
            confirm: permissionMode === "auto" ? async () => true : requestConfirm,
            includePreamble: true,
            desktopPath,
          });
          if (stopIfAborted()) return;
          tools = runtime.tools;
          workspacePreamble = runtime.workspacePreamble;
        }
      }

      const currentProjectId =
        (convId ? conversationList.find((c) => c.id === convId)?.projectId : null) ?? null;
      if (currentProjectId && !pureMode) {
        try {
          const [{ preamble }, project, memories] = await Promise.all([
            retrieveCrossProjectMemoriesForPrompt(currentProjectId, text),
            dbProjects.getById(currentProjectId),
            dbProjectMemories.listByProject(currentProjectId),
          ]);
          if (stopIfAborted()) return;
          projectMemoryPreamble = buildProjectMemoryPreamble(project?.name, memories);
          crossProjectPreamble = preamble;
        } catch {
          // 项目记忆读取失败不阻断主流程
        }
      }

      const tooLargeNotice = (name: string) => t("chat.attachments.fileTooLarge", { name });
      let outgoing = buildChatPromptMessages({
        messages: newMessages,
        effectiveWorkspace,
        primaryIsCli,
        projectMemoryPreamble,
        crossProjectPreamble,
        workspacePreamble,
        tooLargeNotice,
      });
      const compressedPrompt = applyPromptCompression({
        enabled: smart,
        messages: outgoing,
        modelName: model.name,
        contextWindow: model.contextWindow,
        noticeText: (n) => t("chat.contextTrimmed", { count: n }),
      });
      outgoing = compressedPrompt.messages;
      const compressionStats = compressedPrompt.compressionStats;

      // Harness 闭环：回答完后评估是否在编造；编了就回填一条纠正指令让模型自查重答（封顶 1 次）。
      const MAX_HARNESS_RETRY = 1;
      const streamingState = createStreamingTurnState(model.id);
      let convo = outgoing;
      let finalContent = "";
      try {
        for (let attempt = 0; ; attempt++) {
          streamingState.fullContent = "";
          if (attempt > 0) {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: "", harness: undefined } : m)),
            );
          }
          const result = await streamWithFallback(
            chain,
            convo,
            createStreamingTurnCallbacks({
              assistantId,
              controller,
              state: streamingState,
              t,
              setMessages,
              setSwitchNotice,
              setLastUsage,
            }),
            {
              signal: controller.signal,
              conversationId: convId ?? undefined,
              role: taskRole,
              actorRole,
              ...(routingDecision ? { routingDecision } : {}),
              ...(compressionStats ? { compressionStats } : {}),
              ...(tools ? { tools, maxToolSteps: 12 } : {}),
            },
          );
          streamingState.lastResultModelId = result.usedModelId;
          if (controller.signal.aborted) break;

          const verdict = await evalHarnessForConversation(convId, streamingState.fullContent, turnStartedAt);
          const harnessDirty = !!(verdict && !isClean(verdict));
          const nudgeNeeded =
            !harnessDirty &&
            !!tools &&
            streamingState.lastFinishReason === "stop" &&
            streamingState.lastToolCallCount === 0 &&
            detectIntentNoToolCall(streamingState.fullContent);

          const retryDecision = decideStreamRetry({
            pureMode,
            harnessDirty,
            nudgeNeeded,
            attempt,
            maxRetry: MAX_HARNESS_RETRY,
            hasTools: !!tools,
            verdict,
          });
          if (retryDecision.shouldRetry) {
            setHarnessNotice(retryDecision.notice === "harness" ? t("chat.harnessRetry") : t("chat.intentNudgeRetry"));
            convo = [
              ...convo,
              { role: "assistant" as const, content: streamingState.fullContent },
              { role: "user" as const, content: retryDecision.retryPrompt },
            ];
            continue;
          }

          if (harnessDirty) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, harness: { unverifiedPaths: verdict!.unverifiedPaths, pseudoToolNames: verdict!.pseudoToolNames } }
                  : m,
              ),
            );
          }
          break;
        }
        // 最终答案统一落库
        finalContent = streamingState.fullContent;
        prep.persistAssistant(streamingState.fullContent, streamingState.lastModelId, streamingState.lastUsage);
        if (convId && shouldCompleteWorkflowNode && turnWorkflowSnapshot && turnWorkflowRunId && streamingState.fullContent && !controller.signal.aborted) {
          try {
            const nextWorkflow = completeCurrentWorkflowNode({
              snapshot: turnWorkflowSnapshot,
              summary: streamingState.fullContent.slice(0, 1200),
            });
            await workflowRuns.saveSnapshot({
              runId: turnWorkflowRunId,
              snapshot: nextWorkflow,
              eventType: "workflow.node_completed",
              eventPayload: {
                nodeId: turnWorkflowSnapshot.currentNodeId,
                summaryPreview: streamingState.fullContent.slice(0, 240),
              },
            });
            applyWorkflowSnapshot(nextWorkflow);
          } catch {
            // workflow 状态更新失败不影响正常回答
          }
        }
        setHarnessNotice(null);
        if (cacheEligible && streamingState.fullContent && !controller.signal.aborted) {
          void writeCache(text, streamingState.fullContent, streamingState.lastResultModelId, taskRole).catch(() => {});
        }
        (prep as any).finalContent = finalContent;
        (prep as any).finalAssistantMsg = { ...assistantMsg, content: finalContent };
      } catch (err) {
        prep.persistAssistant(streamingState.fullContent, model.id);
        setHarnessNotice(null);
        if ((err as Error).name === "AbortError") {
          if (!streamingState.fullContent) {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: t("chat.stopped") } : m)),
            );
          }
          return;
        }
        setStreamError(classifyLlmError(err, t).userMessage);
        setMessages((prev) => prev.filter((m) => m.id !== assistantId || m.content !== ""));
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        if (convId) {
          void toolExecutions.listByConversation(convId).then(applyToolExecutionRows).catch(() => {});
        }
      }
    }

    // ===== 段5 实现：postStreamOrchestration =====
    async function postStreamOrchestration(prep: Awaited<ReturnType<typeof prepareTurn>>) {
      if (!prep) return;
      const finalContent = (prep as any).finalContent as string | undefined;
      const finalAssistantMsg = (prep as any).finalAssistantMsg as ChatMessage | undefined;
      if (!finalContent || !finalAssistantMsg) return;
      const {
        convId,
        primaryIsCli: _primaryIsCli,
        effectiveWorkspace,
        turnIntentDecision,
      } = prep;
      const taskRole = (prep as any).taskRole;
      const cacheIntent = (prep as any).cacheIntent as TurnIntentDecision;
      if (
        convId &&
        finalContent &&
        !pureMode &&
        !controller.signal.aborted &&
        shouldRunBackgroundOrchestration({
          text,
          taskRole,
          hasWorkspace: Boolean(effectiveWorkspace),
          intentAction: (turnIntentDecision ?? cacheIntent).action,
        })
      ) {
        void runBackgroundOrchestration(convId, [...newMessages, finalAssistantMsg], {
          onChainPlan: ({ chain, roleBindings: bindings }) => {
            if (chain.length === 0 || controller.signal.aborted) return;
            if (!shouldAutoRunChain({ text, chain, decision: turnIntentDecision ?? cacheIntent })) return;
            void runChainIfNeeded({
              chain,
              roleBindings: bindings,
              controller,
              tools: (prep as any).tools,
              conversationId: convId,
              userTask: text,
              messages: newMessages,
            });
          },
        });
      }
    }
  }

  // 队列续发用的 handleSend 句柄镜像。
  // handleSend 每次 ChatPage 重渲染都生成新实例（闭包捕获了 selectedModelId / orchestrationRef 等
  // 一堆当时 state），队列 effect 只依赖 [isStreaming, pendingQueue]，若直接闭包捕获 handleSend 会读到
  // 旧渲染的句柄 → 续发用错模型、abort 失效。这里每渲染都把最新句柄写进 ref，effect 读 ref.current 永远拿到最新。
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  // 后台编排：选最省的非 CLI 模型跑 planNodes → 定模型 → 落库 + 自动切 + 写回执。全程兜底，绝不影响主对话。
  // E2a：编排算完 chainPlan 后通过 opts.onChainPlan 回调通知调用方（让调用方决定要不要跑 watch 接力）。
  async function runBackgroundOrchestration(
    convId: string,
    msgs: ChatMessage[],
    opts?: { onChainPlan?: (info: { chain: RoleId[]; roleBindings: Map<RoleId, string> }) => void },
  ) {
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
      // 阶段 D：查用户在模板里配的 8 角色绑定（无 project 走"默认 8 角色"内置模板兜底）
      const roleBindings = await getRoleBindingsForConversation(convId);
      const rolePerformanceScores = await usageEvents.list()
        .then(buildRolePerformanceScoresFromUsageRows)
        .catch(() => undefined);
      const next = resolveOrchestration(plan, availableModels, prev, roleBindings, rolePerformanceScores);
      // 阶段 E1：算 watch 接力链（零额外 LLM，纯函数按 plan.nodes 顺序 + 封顶 MAX_CHAIN_LENGTH=3）
      const chainPlan = computeChain(plan);
      const nextWithChain = withChainPlan(next, chainPlan);
      const change = diffOrchestration(prev, next);
      // 6.2 修复（2026-07-02）：把"是否要跳过更新"的隐式判断换成纯函数 shouldSkipOrchestrationUpdate。
      // 之前的两个布尔变量 onlyLeaderIdlePlan + prevWasAlreadyIdleLeader 不覆盖
      // prev=stuck_recoverable 的情况——prev 卡在专业节点 + chainPlan 空时跳过会让
      // orchestrationRef 永远停在旧节点（用户下一切简单任务也不会切回 leader）。
      // shouldSkipOrchestrationUpdate 把这个边界条件封装进去：stuck_recoverable 状态一律 false。
      if (shouldSkipOrchestrationUpdate(prev, nextWithChain, chainPlan)) return;

      // E2a：通知调用方 chain 接力计划（让 ChatPage 决定是否触发 watch 接力执行）
      const effectiveChainBindings = new Map(roleBindings);
      for (const node of nextWithChain.nodes) {
        if (node.modelId) effectiveChainBindings.set(node.role, node.modelId);
      }
      opts?.onChainPlan?.({ chain: chainPlan, roleBindings: effectiveChainBindings });

      // 落库总用正确的 convId（即使用户已切走也要存对）
      void dbConversations.saveOrchestration(convId, serializeOrchestration(nextWithChain)).catch(() => {});
      // 用户已切到别的会话 → 不要把本会话的状态/回执塞进当前 UI（切回来会从库加载）
      if (conversationIdRef.current !== convId) return;

      applyOrchestration(nextWithChain);

      if (change.nodeChanged || change.modelChanged) {
        // 自动切：把当前节点的模型设为选中（UI 跟上），下一轮 handleSend 就用它。
        // leader 节点例外——闲聊/答疑尊重用户当前手选的模型，不自动覆盖（否则 minimax 被换成 agnes）
        if (
          change.node?.role !== "leader" &&
          change.node?.modelId &&
          availableModels.some((m) => m.id === change.node!.modelId)
        ) {
          setSelectedModelId(change.node.modelId);
        }
        const receipt = buildOrchestrationReceipt({
          change,
          next,
          prev,
          reason: plan.reason,
          availableModels,
          t,
        });
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

  // E2a：watch 接力执行（每跳真调模型，含 tools 必传 + nudge 套进每跳）
  // UI 完整化（进度条/中止按钮/角色头像）留 E2b；E2a 只让 chain 能跑起来 + 每跳消息带角色名
  async function runChainIfNeeded(args: {
    chain: RoleId[];
    roleBindings: Map<RoleId, string>;
    controller: AbortController;
    tools: WorkspaceToolRuntime["tools"];
    conversationId: string;
    userTask: string;
    messages: ChatMessage[];
  }) {
    if (args.controller.signal.aborted || args.chain.length === 0) return;
    try {
      // 构造 ModelEndpoint[] —— 复用 chat-fallback 的 toModelEndpoint，apiKey 异步取
      const apiModels = availableModels.filter((m) => !isCliProviderType(m.provider?.type ?? "") && m.provider);
      const endpoints: ModelEndpoint[] = [];
      for (const m of apiModels) {
        const cred = credentials.find((c) => c.providerId === m.providerId);
        if (!cred || !m.provider) continue;
        const key = await getApiKey(cred.id);
        if (!key) continue;
        endpoints.push(toModelEndpoint(m, cred, key));
      }
      if (endpoints.length === 0) return;

      // E2b：开跑前重置运行时状态（驱动进度条 + 中止按钮）
      setChainExecutedRoles([]);
      setChainSkippedRoles([]);
      setChainAbortedRole(null);
      setChainRunning(true);

      // 每跳 messageId + content 索引（流式 delta 追加用）
      const roleMsgIds: Partial<Record<RoleId, string>> = {};
      const roleMsgContents: Partial<Record<RoleId, string>> = {};
      const chainPath = buildChainPath({ chain: args.chain, t });

      // E2b：链式接力独立占用一个 abort 引用；主回答结束后 abortRef 会清空，不能再拿它控制 chain。
      chainAbortRef.current = args.controller;
      // E2b：捕获 result 以处理 stoppedAt/skippedRoles（驱动进度条 aborted 状态 + 收尾消息）
      const result = await runChainImpl({
        chain: args.chain,
        userTask: args.userTask,
        controller: args.controller,
        bindings: args.roleBindings,
        models: endpoints,
        // ★ tools 必传（命脉）：让 chain 角色能真调工具，重演 M3 bug 防线
        tools: args.tools,
        conversationId: args.conversationId,
        harnessCheck: async ({ content, startedAt }) => {
          return evalHarnessForConversation(args.conversationId, content, startedAt);
        },
        callbacks: {
          onChainStart: (total) => {
            const id = crypto.randomUUID();
            // E2b：▶ 前缀不再烤进 content，由渲染层从 roleId 派生（同一份信息不两处存）
            setMessages((prev) => [
              ...prev,
              createChainStartMessage({ id, createdAt: new Date().toISOString(), total, path: chainPath, t }),
            ]);
          },
          onRoleStart: (role, idx, total) => {
            const id = crypto.randomUUID();
            roleMsgIds[role] = id;
            roleMsgContents[role] = "";
            // E2b：存 roleId + chainStep（渲染层用）— 不烤前缀进 content
            setMessages((prev) => [
              ...prev,
              createChainRoleMessage({ id, createdAt: new Date().toISOString(), role, index: idx + 1, total }),
            ]);
          },
          onRoleDelta: (role, delta) => {
            const msgId = roleMsgIds[role];
            if (!msgId) return;
            roleMsgContents[role] = (roleMsgContents[role] ?? "") + delta;
            setMessages((prev) => updateChainRoleContent(prev, msgId, roleMsgContents[role] ?? ""));
          },
          onRoleDone: (role, idx, total, content) => {
            const msgId = roleMsgIds[role];
            // E2b：同步 chainExecutedRoles（驱动进度条 done 状态）
            setChainExecutedRoles((prev) => prev.includes(role) ? prev : [...prev, role]);
            void dbMessages.create({
              conversationId: args.conversationId,
              role: "assistant",
              content,
              actorRole: role,
              chainStepIndex: idx + 1,
              chainStepTotal: total,
              chainDone: true,
            }).catch(() => {});
            if (!msgId) return;
            // E2b：标 chainDone=true（渲染层用 ✓）+ content 存原始产出（不带 ✓/角色前缀）
            setMessages((prev) => completeChainRoleMessage({
              messages: prev,
              msgId,
              content,
              index: idx + 1,
              total,
            }));
          },
          // 注：runChain 内部 onChainDone 仅在完整跑完时触发（用户中止/抛错时不触发——E2a 行为），
      // 所以"✓ 接力完成"消息由 await 后的 result 统一决定：
      //   - stoppedAt === null → 插"完成"消息
      //   - stoppedAt !== null → 插"中止"消息（用户中止或某跳出错）
      onUsage: (_usage, _model, _fr) => {
        // 链内 usage 由每跳 streamWithFallback 统一落库，StatsPage 按 roleKind 聚合。
      },
        },
      });
      // E2b：收尾——根据 result.stoppedAt 决定最终消息 + 同步进度条状态
      if (Object.keys(result.roleHarness).length > 0) {
        setMessages((prev) => applyChainHarnessWarnings(prev, result.roleHarness));
      }
      if (result.stoppedAt !== null) {
        setChainAbortedRole(result.stoppedAt);
      }
      const finishId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        createChainFinishMessage({ id: finishId, createdAt: new Date().toISOString(), result, path: chainPath, t }),
      ]);
      if (result.skippedRoles.length > 0) {
        setChainSkippedRoles(result.skippedRoles);
      }
      try {
        applyToolExecutionRows(await toolExecutions.listByConversation(args.conversationId));
      } catch {
        // 工件刷新失败不影响已完成的接力消息
      }
    } catch (err) {
      // 接力失败静默（不阻塞主对话）
      console.error("[chain] 接力执行失败:", err);
    } finally {
      setChainRunning(false);
      if (chainAbortRef.current === args.controller) chainAbortRef.current = null;
    }
  }

  // 停止 = 权威停止：立即把 UI 拉回空闲态，不依赖底层 promise 抛错。
  // 关键：有些 provider（如 MiniMax）卡死时**不理会 AbortSignal**，fetch 既不返回也不抛错，
  // 流式的 finally 永远不执行。若只发 abort() 不强制 setIsStreaming(false)，界面会永远卡「回复中」。
  // 所以这里直接掐 UI 状态 + 清引用 + 清队列；残留的后台 promise 由 controller.signal.aborted
  // 守门（onDelta 丢弃、缓存/编排不写），settle 时进 finally 再 setIsStreaming(false) 也是幂等的。
  function handleStop() {
    abortRef.current?.abort();
    chainAbortRef.current?.abort();
    abortRef.current = null;
    chainAbortRef.current = null;
    setPendingQueue([]);
    setIsStreaming(false);
    setChainRunning(false);
  }

  // 串行排空队列：不忙（没在流式）时取队首发送，发完自动取下一条。
  // drainingRef 守住"取出→handleSend 真正置 isStreaming=true"之间的空窗，防并发重入。
  // handleSend 经由 handleSendRef.current 调用，保证读到最新渲染的句柄（详见 ref 定义处注释）。
  useEffect(() => {
    if (drainingRef.current || isStreaming || pendingQueue.length === 0) return;
    const next = pendingQueue[0]!;
    drainingRef.current = true;
    setPendingQueue((q) => q.slice(1));
    void handleSendRef.current(next.text, next.attachments).finally(() => {
      drainingRef.current = false;
    });
  }, [isStreaming, pendingQueue]);

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

  function handleFormSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const text = String(formData.get("input") ?? "").trim();
    const atts = draftAttachments;
    // 纯空不允许；但只拖图无文字也允许发
    if (!text && atts.length === 0) return;
    // 一律入队，由 drain effect 串行处理：空闲时立刻发，回复中则排队，回完自动接着发。
    setPendingQueue((q) => [...q, { text, ...(atts.length ? { attachments: atts } : {}) }]);
    setDraftAttachments([]);
    (e.currentTarget as HTMLFormElement).reset();
    // form.reset() 只清 value，不清 onChange 里手动写的内联 height——
    // 不重置的话，发送后输入框还会保持发送前撑开的高度，视觉上很奇怪。
    if (inputRef.current) inputRef.current.style.height = "auto";
  }

  const selectedModel = availableModels.find(m => m.id === selectedModelId);
  const activeModelLabel = getActiveAssistantModelLabel(
    messages,
    selectedModel?.displayName ?? selectedModel?.name ?? "—",
  );
  const latestToolCalls = toolCallViews.slice(-8);
  const activeToolCall = pendingConfirm
    ? {
        id: "pending-confirm",
        toolName: pendingConfirm.toolName,
        status: "awaiting_approval" as const,
        shortSummary: pendingConfirm.summary,
        summaryKey: "unknown",
        summaryVars: { tool: pendingConfirm.toolName },
        detailPreview: "",
        detailFull: "",
        createdAt: new Date().toISOString(),
        durationMs: 0,
      }
    : latestToolCalls[latestToolCalls.length - 1];

  // 把工具动作按时间归属到对应那一轮的 assistant 消息：每条消息只显示「它那一轮」干了什么，
  // 对话流里就成了「一个节点跟着一个节点」——而不是全堆在最后一条上。
  // 窗口 = [该 assistant 的 createdAt, 其后第一条带时间戳消息的 createdAt)。
  const toolCallsByMessage = useMemo(() => {
    const map = new Map<string, ToolCallView[]>();
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== "assistant" || m.kind === "receipt" || !m.createdAt) continue;
      const start = m.createdAt;
      let end: string | null = null;
      for (let j = i + 1; j < messages.length; j++) {
        const c = messages[j].createdAt;
        if (c) { end = c; break; }
      }
      map.set(
        m.id,
        toolCallViews.filter((tc) => tc.createdAt >= start && (end === null || tc.createdAt < end)),
      );
    }
    return map;
  }, [messages, toolCallViews]);

  const chainNodeGraph = useMemo(() => deriveChainNodeGraph({
    orchestration,
    workflowSnapshot,
    selectedModelId,
    selectedModelName: selectedModel?.displayName ?? selectedModel?.name ?? selectedModelId,
    availableModels,
    chainRunning,
    chainExecutedRoles,
    chainSkippedRoles,
    chainAbortedRole,
  }), [
    orchestration,
    selectedModelId,
    selectedModel?.displayName,
    selectedModel?.name,
    workflowSnapshot,
    availableModels,
    chainRunning,
    chainExecutedRoles,
    chainSkippedRoles,
    chainAbortedRole,
  ]);

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
      {/* 写操作确认：只做审批，不展示工作内容；详情放右侧工作面板。
          UI 修复（2026-07-02）：从独立悬浮卡片改成贴着输入框的小提示条，渲染挪到 ChatInputDock 内部。 */}
      <ChatHeader
        conversations={conversationList}
        conversationId={conversationId}
        selectedModelId={selectedModelId}
        availableModels={availableModels}
        panelOpen={panelOpen}
        lastUsage={lastUsage}
        switchNotice={switchNotice}
        cacheNotice={cacheNotice}
        harnessNotice={harnessNotice}
        onSwitchConversation={(id) => void switchConversation(id)}
        onNewChat={() => void handleNewChat()}
        onDeleteConversation={(id) => void handleDeleteConversation(id)}
        onRenameConversation={(id, title) => void handleRenameConversation(id, title)}
        onModelChange={handleModelChange}
        onSmartPick={() => void handleSmartPick()}
        onTogglePanel={() => setPanelOpen((v) => !v)}
      />

      {/* 对话列表容器 */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scroll-smooth custom-scrollbar"
      >
        <ChatTranscript
          availableModelCount={availableModels.length}
          messages={messages}
          isStreaming={isStreaming}
          pendingQueue={pendingQueue}
          inputAreaH={inputAreaH}
          streamElapsedMs={streamElapsedMs}
          toolCallsByMessage={toolCallsByMessage}
          streamError={streamError}
          onEnableWorkspaceProtection={
            workspacePath && !protectedWorkspaces.has(workspacePath)
              ? async () => {
                  await enableWorkspaceProtection(workspacePath);
                  setProtectedWorkspaces((prev) => new Set(prev).add(workspacePath));
                }
              : undefined
          }
        />
      </div>

      {/* 回到底部：用户往上翻看历史时出现，点一下回到最新（输出再多也不抢滚动） */}
      {showJumpToBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          title={t("chat.jumpToBottom")}
          className="absolute bottom-28 left-1/2 -translate-x-1/2 z-30 w-9 h-9 rounded-full glass border border-white/15 shadow-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors animate-in fade-in slide-in-from-bottom-2 duration-300"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}

      <ChatInputDock
        inputAreaRef={inputAreaRef}
        inputRef={inputRef}
        onSubmit={handleFormSubmit}
        onPaste={handlePaste}
        activeToolCall={activeToolCall}
        isStreaming={isStreaming}
        workspacePath={workspacePath}
        onClearWorkspace={() => void clearWorkspace()}
        onChooseWorkspace={() => void chooseWorkspace()}
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        draftAttachments={draftAttachments}
        onRemoveAttachment={removeAttachment}
        selectedModelName={selectedModel ? selectedModel.displayName || selectedModel.name : null}
        onStop={handleStop}
        pendingConfirm={pendingConfirm}
        onResolveConfirm={resolveConfirm}
      />
      </div>

      {panelOpen && (
        <ChatWorkPanel
          width={workPanel.width}
          onResizeMouseDown={workPanel.onMouseDown}
          onClose={() => setPanelOpen(false)}
          nodes={chainNodeGraph.nodes}
          availableModels={availableModels}
          disabled={isStreaming}
          onMainModelChange={handleModelChange}
          onNodeModelChange={handleNodeModelChange}
          conversationId={conversationId}
          workspacePath={workspacePath}
          artifacts={artifacts}
          running={isStreaming}
          streamElapsedMs={streamElapsedMs}
          activeModelLabel={activeModelLabel}
          messages={messages}
        />
      )}
    </div>
  );
}
