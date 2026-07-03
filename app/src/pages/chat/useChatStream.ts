import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { TFunction } from "i18next";
import { desktopDir } from "@tauri-apps/api/path";
import { getApiKey } from "@/lib/keystore";
import {
  conversations as dbConversations,
  messages as dbMessages,
  toolExecutions,
  workflowRuns,
  intentLearning,
  getRoleBindingsForConversation,
  projects as dbProjects,
  projectMemories as dbProjectMemories,
  usageEvents,
  type Conversation,
  type ToolExecutionRow,
} from "@/lib/db";
import { type ModelListItem, type CredentialListItem } from "@/lib/api";
import { type Attachment } from "@/lib/llm/attachments";
import { type OrchestrationState, type RoleId } from "@/lib/llm/orchestrator";
import { type TurnIntentDecision, type WorkflowSnapshot } from "@/lib/workflow/types";
import { type IntentExample } from "@/lib/workflow/semantic-intent-router";
import { type ToolConfirmRequest } from "@/lib/llm/tools";
import {
  type ModelEndpoint,
  type StreamUsage,
  toModelEndpoint,
  streamWithFallback,
} from "@/lib/llm/chat-fallback";
import { isCliProviderType } from "@/lib/llm/cli-protocol";
import { classifyMessageComplexity } from "@/lib/llm/message-router";
import {
  shouldAutoRunChain,
  shouldRunBackgroundOrchestration,
} from "@/lib/llm/orchestration-gating";
import {
  planNodes,
  resolveOrchestration,
  diffOrchestration,
  currentNode,
  serializeOrchestration,
  withChainPlan,
  computeChain,
  shouldSkipOrchestrationUpdate,
  type OrchestrationTurn,
  pickOrchestratorModel,
} from "@/lib/llm/orchestrator";
import { buildRolePerformanceScoresFromUsageRows } from "@/lib/llm/model-performance-scoring";
import { getLanguageModel } from "@/lib/llm/provider-factory";
import { isPureSingleModelModeEnabled, isSmartRoutingEnabled } from "@/lib/app-settings";
import { shouldExposeWriteTools, impliesWriteIntent } from "@/lib/llm/tool-permission-policy";
import { lookupCache, writeCache } from "@/lib/llm/semantic-cache";
import { buildProjectMemoryPreamble } from "@/lib/llm/context-preamble";
import { buildWorkspacePreamble } from "@/lib/llm/workspace-context";
import {
  prepareWorkspaceToolRuntime,
  type WorkspaceToolRuntime,
} from "@/lib/llm/workspace-tool-runtime";
import { createCodeTaskWorkflowSnapshot } from "@/lib/workflow/code-task-template";
import { classifyTurnIntentWithJudge } from "@/lib/workflow/intent-judge";
import { isExplicitDebateRequest } from "@/lib/workflow/intent-classifier";
import { detectIntentCorrection, intentActionLabel } from "@/lib/workflow/intent-feedback";
import { applyTurnIntentDecision, completeCurrentWorkflowNode } from "@/lib/workflow/reducer";
import { evaluateHarness, isClean, detectIntentNoToolCall } from "@/lib/llm/harness/feedback";
import { runChain as runChainImpl } from "@/lib/llm/chain-runner";
import { classifyLlmError } from "@/lib/llm/error-classifier";
import { retrieveCrossProjectMemoriesForPrompt } from "@/lib/memory/retrieval";
import { runDynamicDebate } from "@/lib/llm/debate-engine";
import { realRunRole } from "@/lib/llm/debate-runner";
import { archiveDynamicDebateResult } from "@/lib/llm/debate-persistence";
import { createOptimisticUserTurn } from "@/pages/chat/optimistic-turn";
import {
  applyChainHarnessWarnings,
  buildChainPath,
  completeChainRoleMessage,
  createChainFinishMessage,
  createChainRoleMessage,
  createChainStartMessage,
  updateChainRoleContent,
} from "@/pages/chat/chain-messages";
import { buildDebateParticipants } from "@/pages/chat/debate-participants";
import { buildDebateTopic, formatDebateResultMessage } from "@/pages/chat/debate-result";
import { buildMainChatModelChain } from "@/pages/chat/model-chain";
import { buildOrchestrationReceipt } from "@/pages/chat/orchestration-receipt";
import { applyPromptCompression } from "@/pages/chat/prompt-compression";
import { buildChatPromptMessages } from "@/pages/chat/prompt-messages";
import { decideStreamRetry } from "@/pages/chat/stream-retry";
import { createStreamingTurnCallbacks, createStreamingTurnState } from "@/pages/chat/streaming-callbacks";
import { filterReadRecordsSince } from "@/pages/chat/history";
import type { ChatMessage, PendingRoutingDecision, PendingSend } from "@/pages/chat/types";

interface AlertOptions {
  title: string;
  description: string;
}

type ChatUsage = StreamUsage;

export interface UseChatStreamOptions {
  // 顶层 state
  conversationId: string | null;
  conversationList: Conversation[];
  // getSelectedModelId()/getAvailableModels()/getCredentials() 改为 getter 模式（hook B 持 state + ChatPage 顶层 useState 镜像）——
  // 避免 hook B 持 state → hook C 又依赖的循环
  getSelectedModelId: () => string;
  setSelectedModelId: (id: string) => void;
  getAvailableModels: () => ModelListItem[];
  getCredentials: () => CredentialListItem[];
  workspacePath: string | null;
  setWorkspacePath: Dispatch<SetStateAction<string | null>>;
  permissionMode: "read" | "confirm" | "auto";
  panelOpen: boolean;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  // isStreaming 提到 ChatPage 顶层共享（hook C + hook E 都需要）
  isStreaming: boolean;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;

  // hook B (model)
  handleModelChange: (newId: string) => void;
  handleNodeModelChange: (nodeId: string, modelId: string) => void;

  // hook D (orchestration)
  orchestration: OrchestrationState | null;
  orchestrationRef: MutableRefObject<OrchestrationState | null>;
  workflowSnapshot: WorkflowSnapshot | null;
  workflowSnapshotRef: MutableRefObject<WorkflowSnapshot | null>;
  applyOrchestration: (next: OrchestrationState | null) => void;
  applyWorkflowSnapshot: (next: WorkflowSnapshot | null) => void;
  setChainExecutedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  setChainSkippedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  setChainAbortedRole: (role: RoleId | null) => void;
  setChainRunning: (running: boolean) => void;
  chainAbortRef: MutableRefObject<AbortController | null>;

  // hook E (work panel)
  applyToolExecutionRows: (rows: ToolExecutionRow[]) => void;
  clearToolExecutionViews: () => void;
  bindWorkspace: (path: string) => Promise<void>;
  requestConfirm: (req: ToolConfirmRequest) => Promise<boolean>;

  // hook F + 顶层 ref
  scrollRef: RefObject<HTMLDivElement | null>;
  inputAreaRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  stickToBottomRef: MutableRefObject<boolean>;
  pendingRoutingDecisionRef: MutableRefObject<PendingRoutingDecision | null>;

  // i18n + UI
  t: TFunction;
  alert: (opts: AlertOptions) => Promise<void>;
}



/** hook C：流式主循环 + 队列 + handleSend 整套（5 段 helper + runBackgroundOrchestration +
 *  runChainIfNeeded + handleStop + 流式计时 + 自动滚底 + 队列排空 effect）。
 *  持 10 state（messages/isStreaming/streamElapsedMs/pendingQueue/streamError/switchNotice/
 *  cacheNotice/harnessNotice/lastUsage/streamError）+ 2 ref（abortRef/drainingRef）。
 *  外部 deps 接收 hook A/B/D/E/F + i18n + alert 等所有跨 hook 依赖。 */
export function useChatStream(opts: UseChatStreamOptions) {
  const {
    conversationId,
    conversationList,
    getSelectedModelId,
    setSelectedModelId,
    getAvailableModels,
    getCredentials,
    workspacePath,
    setWorkspacePath,
    permissionMode,
    panelOpen: _panelOpen,
    setPanelOpen,
    isStreaming,
    setIsStreaming,
    handleModelChange: _handleModelChange,
    handleNodeModelChange,
    orchestration: _orchestration,
    orchestrationRef,
    workflowSnapshot: _workflowSnapshot,
    workflowSnapshotRef,
    applyOrchestration,
    applyWorkflowSnapshot,
    setChainExecutedRoles,
    setChainSkippedRoles,
    setChainAbortedRole,
    setChainRunning,
    chainAbortRef,
    applyToolExecutionRows,
    clearToolExecutionViews: _clearToolExecutionViews,
    bindWorkspace: _bindWorkspace,
    requestConfirm,
    scrollRef,
    inputAreaRef: _inputAreaRef,
    inputRef: _inputRef,
    stickToBottomRef,
    pendingRoutingDecisionRef,
    t,
    alert: _alert,
  } = opts;

  // 流式 state（isStreaming 提到 ChatPage 顶层共享，避免 hook C/E 循环依赖）
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamElapsedMs, setStreamElapsedMs] = useState(0);
  const [pendingQueue, setPendingQueue] = useState<PendingSend[]>([]);
  const drainingRef = useRef(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  const [harnessNotice, setHarnessNotice] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<ChatUsage | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 流式计时 effect
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

  // 新内容到达时自动滚底（只有用户仍贴在底部才滚，否则纹丝不动）
  useEffect(() => {
    if (scrollRef.current && stickToBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, scrollRef, stickToBottomRef]);

  // evalHarnessForConversation：当前会话的本轮工具审计 + harness 判定
  async function evalHarnessForConversation(
    convId: string | null,
    content: string,
    sinceIso: string | null,
  ) {
    if (!convId || !content.trim()) return null;
    try {
      const all = await toolExecutions.listByConversation(convId);
      applyToolExecutionRows(all);
      // filterReadRecordsSince 静态导入
      const readRecords = filterReadRecordsSince(all, sinceIso);
      return evaluateHarness(content, readRecords);
    } catch {
      return null;
    }
  }

  // handleSend 整体（含 5 段 helper）
  async function handleSend(text: string, attachments?: Attachment[]) {
    const activeNode = currentNode(orchestrationRef.current);
    const nodeModelId = activeNode?.role === "leader" ? null : (activeNode?.modelId ?? null);
    const actorRole = activeNode?.role ?? "leader";
    const effectiveId =
      nodeModelId && getAvailableModels().some((m) => m.id === nodeModelId) ? nodeModelId : getSelectedModelId();
    const foundModel = getAvailableModels().find((m) => m.id === effectiveId);
    if (!foundModel || isStreaming) return;
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
    if (effectiveId !== getSelectedModelId()) setSelectedModelId(effectiveId);

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
    const isFirstMessage = messages.length === 0;
    const smart = isSmartRoutingEnabled();
    const pureMode = isPureSingleModelModeEnabled();
    const optimisticTurn = createOptimisticUserTurn<ChatMessage>({ messages, text, attachments });
    const userMsg: ChatMessage = optimisticTurn.userMsg;
    const newMessages: ChatMessage[] = [...messages, userMsg];
    let userId = userMsg.id;
    stickToBottomRef.current = true;
    setMessages(newMessages);

    try {
      const prep = await prepareTurn();
      if (prep === null) return;
      if (await maybeRunDebate(prep)) return;
      if (await tryCacheHit(prep)) return;
      await runStreamLoop(prep);
      await postStreamOrchestration(prep);
    } finally {
      cleanupStoppedTurn();
    }

    async function prepareTurn() {
      const cred = getCredentials().find((c) => c.providerId === model.providerId);
      if (!cred) {
        setStreamError(t("chat.noCredential"));
        cleanupStoppedTurn();
        return null;
      }
      const primaryIsCli = isCliProviderType(model.provider?.type ?? "");
      // getApiKey 静态导入
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

      const hasImage = attachments?.some((a) => a.kind === "image");
      if (hasImage && primaryIsCli) {
        setStreamError(t("chat.attachments.cliNoImage"));
        cleanupStoppedTurn();
        return null;
      }
      const folderAtt = attachments?.find((a) => a.kind === "folder");
      if (folderAtt) setWorkspacePath(folderAtt.path);
      const effectiveWorkspace = folderAtt?.path ?? workspacePath;

      let convId = conversationId;
      if (!convId) {
        try {
          const c = await dbConversations.getOrCreateMainChat(model.id, t("chat.untitledChat"));
          convId = c.id;
        } catch {
          // 落库不可用时降级为纯内存
        }
      }
      if (stopIfAborted()) return null;
      if (convId) {
        try {
          userId = (await dbMessages.create({ conversationId: convId, role: "user", content: text, attachments: attachments?.length ? JSON.stringify(attachments) : null })).id;
        } catch {
          // 写库失败降级用内存 id
        }
        if (isFirstMessage) {
          const title = text.slice(0, 40);
          const cid = convId;
          void dbConversations.rename(cid, title).catch(() => {});
        } else {
          void dbConversations.touch(convId).catch(() => {});
        }
      }
      if (stopIfAborted()) return null;

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
      let intentJudgeCalledThisTurn = false;
      let workflowAdvancedThisTurn = false;
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
          // workflow 失败不阻断主对话
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

    async function maybeRunDebate(prep: Awaited<ReturnType<typeof prepareTurn>>): Promise<boolean> {
      if (!prep) return false;
      const {
        turnWorkflowSnapshot,
        turnWorkflowRunId,
        convId,
        effectiveWorkspace,
        turnIntentDecision,
        workflowAdvancedThisTurn,
      } = prep;
      const currentWorkflowNode = turnWorkflowSnapshot?.nodes.find((n) => n.id === turnWorkflowSnapshot?.currentNodeId) ?? null;
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
          // 建临时 run 失败不阻断博弈本身
        }
      }

      const assistantId = crypto.randomUUID();
      const estimatedParticipants = Math.min(Math.max(getAvailableModels().length, 1), 4);
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
        // getApiKey 静态导入
        const participants = await buildDebateParticipants({
          primaryModel: model,
          availableModels: getAvailableModels(),
          credentials: getCredentials(),
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
          const found = getAvailableModels().find((m) => m.id === modelId);
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

    async function tryCacheHit(prep: Awaited<ReturnType<typeof prepareTurn>>): Promise<boolean> {
      if (!prep) return false;
      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "", createdAt: new Date().toISOString(), modelLabel: model.displayName ?? model.name };
      stickToBottomRef.current = true;
      setMessages([...newMessages, assistantMsg]);
      setIsStreaming(true);
      setStreamError(null);
      setSwitchNotice(null);
      setCacheNotice(null);

      const taskRole = classifyMessageComplexity(text);
      const turnStartedAt = new Date().toISOString();

      const cacheWorkspace = prep.folderAtt?.path ?? workspacePath;
      const cacheIntent: TurnIntentDecision =
        pureMode
          ? { action: "answer_only", targetRunId: null, confidence: 1, reason: "pure-single-model-mode", evidenceTurnIds: [] }
          : prep.intentJudgeCalledThisTurn && prep.turnIntentDecision
            ? prep.turnIntentDecision
            : await classifyTurnIntentWithJudge({ text, activeRun: workflowSnapshotRef.current, model: prep.intentJudgeModel });
      const cacheEligible = !pureMode && smart && !cacheWorkspace && cacheIntent.action === "answer_only";

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
          // 缓存查询失败不影响主流程
        }
      }

      (prep as any).assistantId = assistantId;
      (prep as any).assistantMsg = assistantMsg;
      (prep as any).taskRole = taskRole;
      (prep as any).turnStartedAt = turnStartedAt;
      (prep as any).cacheIntent = cacheIntent;
      (prep as any).cacheEligible = cacheEligible;
      return false;
    }

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

      let chain: ModelEndpoint[];
      try {
        // getApiKey 静态导入
        chain = await buildMainChatModelChain({
          primaryModel: model,
          primaryCredential: cred,
          primaryApiKey: apiKey,
          primaryIsCli,
          availableModels: getAvailableModels(),
          credentials: getCredentials(),
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

      let tools: WorkspaceToolRuntime["tools"];
      let workspacePreamble: string | null = null;
      let projectMemoryPreamble: string | null = null;
      let crossProjectPreamble: string | null = null;
      const includeWriteTools = shouldExposeWriteTools({
        text,
        permissionMode,
        decision: cacheIntent,
      });

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

    async function postStreamOrchestration(prep: Awaited<ReturnType<typeof prepareTurn>>) {
      if (!prep) return;
      const finalContent = (prep as any).finalContent as string | undefined;
      const finalAssistantMsg = (prep as any).finalAssistantMsg as ChatMessage | undefined;
      if (!finalContent || !finalAssistantMsg) return;
      const {
        convId,
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

    async function runBackgroundOrchestration(
      convId: string,
      msgs: ChatMessage[],
      opts2?: { onChainPlan?: (info: { chain: RoleId[]; roleBindings: Map<RoleId, string> }) => void },
    ) {
      try {
        const apiModels = getAvailableModels().filter((m) => !isCliProviderType(m.provider?.type ?? ""));
        const orchModel = pickOrchestratorModel(apiModels);
        if (!orchModel || !orchModel.provider) return;
        const cred = getCredentials().find((c) => c.providerId === orchModel.providerId);
        if (!cred) return;
        // getApiKey 静态导入
        const key = (await getApiKey(cred.id)) ?? "";
        if (!key) return;
        const lm = getLanguageModel(orchModel.provider.type, orchModel.name, key, cred.baseUrl);

        const history: OrchestrationTurn[] = msgs
          .filter((m) => m.kind !== "receipt" && m.content)
          .map((m) => ({ role: m.role, content: m.content }));

        const prev = orchestrationRef.current;
        const plan = await planNodes(lm, history, prev);
        const roleBindings = await getRoleBindingsForConversation(convId);
        const rolePerformanceScores = await usageEvents.list()
          .then(buildRolePerformanceScoresFromUsageRows)
          .catch(() => undefined);
        const next = resolveOrchestration(plan, getAvailableModels(), prev, roleBindings, rolePerformanceScores);
        const chainPlan = computeChain(plan);
        const nextWithChain = withChainPlan(next, chainPlan);
        const change = diffOrchestration(prev, next);
        if (shouldSkipOrchestrationUpdate(prev, nextWithChain, chainPlan)) return;

        const effectiveChainBindings = new Map(roleBindings);
        for (const node of nextWithChain.nodes) {
          if (node.modelId) effectiveChainBindings.set(node.role, node.modelId);
        }
        opts2?.onChainPlan?.({ chain: chainPlan, roleBindings: effectiveChainBindings });

        void dbConversations.saveOrchestration(convId, serializeOrchestration(nextWithChain)).catch(() => {});
        if (conversationId !== convId) return;

        applyOrchestration(nextWithChain);

        if (change.nodeChanged || change.modelChanged) {
          if (
            change.node?.role !== "leader" &&
            change.node?.modelId &&
            getAvailableModels().some((m) => m.id === change.node!.modelId)
          ) {
            setSelectedModelId(change.node.modelId);
          }
          const receipt = buildOrchestrationReceipt({
            change,
            next,
            prev,
            reason: plan.reason,
            availableModels: getAvailableModels(),
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
        // 编排失败静默
      }
    }

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
        const apiModels = getAvailableModels().filter((m) => !isCliProviderType(m.provider?.type ?? "") && m.provider);
        const endpoints: ModelEndpoint[] = [];
        for (const m of apiModels) {
          const cred = getCredentials().find((c) => c.providerId === m.providerId);
          if (!cred || !m.provider) continue;
          // getApiKey 静态导入
          const key = await getApiKey(cred.id);
          if (!key) continue;
          endpoints.push(toModelEndpoint(m, cred, key));
        }
        if (endpoints.length === 0) return;

        setChainExecutedRoles([]);
        setChainSkippedRoles([]);
        setChainAbortedRole(null);
        setChainRunning(true);

        const roleMsgIds: Partial<Record<RoleId, string>> = {};
        const roleMsgContents: Partial<Record<RoleId, string>> = {};
        const chainPath = buildChainPath({ chain: args.chain, t });

        chainAbortRef.current = args.controller;
        const result = await runChainImpl({
          chain: args.chain,
          userTask: args.userTask,
          controller: args.controller,
          bindings: args.roleBindings,
          models: endpoints,
          tools: args.tools,
          conversationId: args.conversationId,
          harnessCheck: async ({ content, startedAt }) => {
            return evalHarnessForConversation(args.conversationId, content, startedAt);
          },
          callbacks: {
            onChainStart: (total) => {
              const id = crypto.randomUUID();
              setMessages((prev) => [
                ...prev,
                createChainStartMessage({ id, createdAt: new Date().toISOString(), total, path: chainPath, t }),
              ]);
            },
            onRoleStart: (role, idx, total) => {
              const id = crypto.randomUUID();
              roleMsgIds[role] = id;
              roleMsgContents[role] = "";
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
              setMessages((prev) => completeChainRoleMessage({
                messages: prev,
                msgId,
                content,
                index: idx + 1,
                total,
              }));
            },
            onUsage: (_usage, _model, _fr) => {
              // 链内 usage 由每跳 streamWithFallback 统一落库
            },
          },
        });
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
        // 接力失败静默
        console.error("[chain] 接力执行失败:", err);
      } finally {
        setChainRunning(false);
        if (chainAbortRef.current === args.controller) chainAbortRef.current = null;
      }
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    chainAbortRef.current?.abort();
    abortRef.current = null;
    chainAbortRef.current = null;
    setPendingQueue([]);
    setIsStreaming(false);
    setChainRunning(false);
  }

  // handleSend 句柄镜像（队列 effect 读 ref.current 保证最新闭包）
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  // 串行排空队列
  useEffect(() => {
    if (drainingRef.current || isStreaming || pendingQueue.length === 0) return;
    const next = pendingQueue[0]!;
    drainingRef.current = true;
    setPendingQueue((q) => q.slice(1));
    void handleSendRef.current(next.text, next.attachments).finally(() => {
      drainingRef.current = false;
    });
  }, [isStreaming, pendingQueue]);

  // 暴露 handleNodeModelChange 调用 hook D 的链节点绑定（ChatPage 协调层用）
  // 这个函数实际不需要 useCallback——但 ChatPage 渲染时会通过 hook C 拿到它
  const handleNodeModelChangeBound = useCallback(
    (nodeId: string, modelId: string) => handleNodeModelChange(nodeId, modelId),
    [handleNodeModelChange],
  );
  // 显式抑制 lint：handleNodeModelChangeBound 当前未对外暴露，保留供阶段 8 协调层使用
  void handleNodeModelChangeBound;

  return {
    abortRef,
    cacheNotice,
    drainingRef,
    handleSend,
    handleStop,
    harnessNotice,
    lastUsage,
    messages,
    pendingQueue,
    setLastUsage,
    setMessages,
    setPendingQueue,
    setStreamElapsedMs,
    setStreamError,
    setHarnessNotice,
    setSwitchNotice,
    setCacheNotice,
    streamElapsedMs,
    streamError,
    switchNotice,
  };
}
