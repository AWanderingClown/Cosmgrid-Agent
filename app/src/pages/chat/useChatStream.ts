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
  usageEvents,
  type Conversation,
  type ToolExecutionRow,
} from "@/lib/db";
import { type ModelListItem, type CredentialListItem } from "@/lib/api";
import { type Attachment } from "@/lib/llm/attachments";
import { type OrchestrationState, type RoleId } from "@/lib/llm/orchestrator";
import { type TurnIntentDecision, type WorkflowSnapshot } from "@/lib/workflow/types";
import { BUILTIN_INTENT_EXAMPLES, type IntentExample } from "@/lib/workflow/semantic-intent-router";
import { type ToolConfirmRequest, type AskUserRequest } from "@/lib/llm/tools";
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
import { isDeveloperDiagnosticsEnabled, isPureSingleModelModeEnabled, isSmartRoutingEnabled } from "@/lib/app-settings";
import { shouldExposeWriteTools, impliesWriteIntent } from "@/lib/llm/tool-permission-policy";
import { lookupCache, writeCache } from "@/lib/llm/semantic-cache";
import { buildProjectMemoryPreamble } from "@/lib/llm/context-preamble";
import { buildWorkspacePreamble } from "@/lib/llm/workspace-context";
import { getFsAdapter } from "@/lib/llm/tools/fs-adapter";
import {
  prepareWorkspaceToolRuntime,
  type WorkspaceToolRuntime,
} from "@/lib/llm/workspace-tool-runtime";
import { createCodeTaskWorkflowSnapshot } from "@/lib/workflow/code-task-template";
import { classifyTurnIntentWithJudge } from "@/lib/workflow/intent-judge";
import { isExplicitDebateRequest } from "@/lib/workflow/intent-classifier";
import { detectIntentCorrection, intentActionLabel } from "@/lib/workflow/intent-feedback";
import { downweightMisjudgedExampleInDb } from "@/lib/workflow/intent-decay";
import { appendIntentDiagnostics } from "@/lib/workflow/intent-diagnostics-buffer";
import { routeTurnIntentSemantically } from "@/lib/workflow/semantic-intent-router";
import { buildSkillPreamble } from "@/lib/skills/preamble";
import { selectSkillForTurn } from "@/lib/skills/selector";
import { applyTurnIntentDecision, attachActiveSkillToWorkflow, attachPlanSourceToWorkflow, completeCurrentWorkflowNode } from "@/lib/workflow/reducer";
import { buildWorkflowContextPreamble, readDesktopPlanForExecution } from "@/lib/workflow/execution-context";
import { evaluateHarness, isClean, detectIntentNoToolCall } from "@/lib/llm/harness/feedback";
import {
  classifyFabricationGate,
  judgeFabrication,
  FABRICATION_CONFIDENCE_THRESHOLD,
} from "@/lib/llm/harness/fabrication-judge";
import {
  buildFabricationEvidenceSummary,
  selectRowsForMessage,
} from "@/lib/llm/harness/fabrication-evidence";
import { runChain as runChainImpl } from "@/lib/llm/chain-runner";
import { classifyLlmError } from "@/lib/llm/error-classifier";
import { formatLocalMcpLaunch } from "@/lib/mcp/session-scope";
import {
  retrieveCrossProjectMemoriesForPrompt,
  retrieveProjectMemoriesForPrompt,
} from "@/lib/memory/retrieval";
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
import { buildDebateTopic, formatDebateResultMessage, isFullDebateResult } from "@/pages/chat/debate-result";
import { buildMainChatModelChain } from "@/pages/chat/model-chain";
import { buildOrchestrationReceipt } from "@/pages/chat/orchestration-receipt";
import { applyPromptCompressionWithSummary } from "@/pages/chat/prompt-compression";
import { buildChatPromptMessages } from "@/pages/chat/prompt-messages";
import { decideStreamRetry } from "@/pages/chat/stream-retry";
import { createStreamingTurnCallbacks, createStreamingTurnState } from "@/pages/chat/streaming-callbacks";
import { filterReadRecordsSince, filterFetchRecordsSince, filterExecRecordsSince } from "@/pages/chat/history";
import type { ChatMessage, PendingRoutingDecision, PendingSend } from "@/pages/chat/types";

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
  /**
   * 检测到写意图但权限只读时，主动弹窗问用户要不要切到「确认后修改」——不传则退化成
   * 只插一条文字提示（旧行为）。同一个会话只弹一次，见 handleSend 内 escalationPromptedRef。
   */
  escalatePermission?: () => Promise<boolean>;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  // isStreaming 提到 ChatPage 顶层共享（hook C + hook E 都需要）
  isStreaming: boolean;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;

  // hook D (orchestration)
  handleNodeModelChange: (nodeId: string, modelId: string) => void;
  orchestrationRef: MutableRefObject<OrchestrationState | null>;
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
  requestConfirm: (req: ToolConfirmRequest) => Promise<boolean>;
  requestAskUser: (req: AskUserRequest) => Promise<string>;

  // hook F + 顶层 ref
  scrollRef: RefObject<HTMLDivElement | null>;
  stickToBottomRef: MutableRefObject<boolean>;
  pendingRoutingDecisionRef: MutableRefObject<PendingRoutingDecision | null>;

  // i18n + UI
  t: TFunction;
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
    escalatePermission,
    setPanelOpen,
    isStreaming,
    setIsStreaming,
    handleNodeModelChange,
    orchestrationRef,
    workflowSnapshotRef,
    applyOrchestration,
    applyWorkflowSnapshot,
    setChainExecutedRoles,
    setChainSkippedRoles,
    setChainAbortedRole,
    setChainRunning,
    chainAbortRef,
    applyToolExecutionRows,
    requestConfirm,
    requestAskUser,
    scrollRef,
    stickToBottomRef,
    pendingRoutingDecisionRef,
    t,
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
  // 2026-07-07 加：会话/消息落库失败之前是纯静默 catch（"降级为纯内存"），UI 照常显示、
  // 用户毫无察觉——直到重启 app 发现整段对话消失，且没有任何日志能回溯到底发生了什么
  // （复现过一次真实事故：17 步工具调用的长轮次里，conversation.touch()/tool_executions
  // 写入 + git 自动提交并发写同一个 sqlite 文件，withBusyRetry 的退避重试预算被打满后
  // dbMessages.create 静默失败，那一整轮聊天记录再没进过库）。这里不改变"落库失败不阻断
  // 当前对话"的降级策略本身，只是让失败变得可见——用户至少能在出问题的当下看到提示，
  // 而不是事后从数据库里找不到任何痕迹。
  const [persistNotice, setPersistNotice] = useState<string | null>(null);
  // 2026-07-05 加：对弈进行中，右侧工作流面板的"模型博弈"节点原来一直显示死板的"动态分配"
  // 占位符，看不出到底是哪几个模型在博弈——这里把真实参与者存出来给面板渲染。
  // debate 结束（成功/中止/失败）在下面 finally 块里清空，不残留上一轮的参与者列表。
  const [debateParticipants, setDebateParticipants] = useState<{ modelId: string; modelName: string }[] | null>(null);
  const [lastUsage, setLastUsage] = useState<ChatUsage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 写权限升级弹窗只在同一个会话里问一次——记已经问过（不管用户同意与否）的会话 id */
  const escalationPromptedRef = useRef<Set<string>>(new Set());

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
  //
  // 两阶段（2026-07-09 加 fabrication 第二阶段）：
  //   阶段 A：现有硬校验（extract-claims / verify-claims / detect-pseudo-tools /
  //           detect-usage-narration），由 evaluateHarness 输出 verdict
  //   阶段 B：verdict 干净时调 fabrication-judge（按 messageId 优先 + sinceIso 兜底
  //           的证据摘要），命中阈值后回写 fabricationSuspected
  //
  // 两阶段共用同一份 tool_executions 查询，避免重复 IO。返回的 verdict 由调用方
  // （主对话 / 团队负责人链路）走同一个 isClean / buildCorrectionPrompt 闭环。
  async function evalHarnessForConversation(
    convId: string | null,
    content: string,
    sinceIso: string | null,
    actualToolCallCount = 0,
    opts: {
      assistantMessageId?: string | null;
      finishReason?: string | null;
      judgeModel?: import("@/lib/llm/provider-factory").LanguageModel | null;
    } = {},
  ) {
    if (!convId || !content.trim()) return null;
    try {
      const all = await toolExecutions.listByConversation(convId);
      applyToolExecutionRows(all);
      // filterReadRecordsSince/filterFetchRecordsSince/filterExecRecordsSince 静态导入
      const readRecords = filterReadRecordsSince(all, sinceIso);
      const fetchRecords = filterFetchRecordsSince(all, sinceIso);
      const execRecords = filterExecRecordsSince(all, sinceIso);
      const verdict = evaluateHarness(
        content,
        readRecords,
        actualToolCallCount,
        fetchRecords,
        execRecords,
      );

      // 阶段 A 已命中（regex 已抓到）→ 不再调语义裁判（避免双重处罚 + 节省成本）
      if (!isClean(verdict)) return verdict;

      // 阶段 B：交给辅助函数（避免本函数超 50 行）
      return await runFabricationJudgeStage(all, verdict, {
        content,
        sinceIso,
        actualToolCallCount,
        finishReason: opts.finishReason ?? "stop",
        assistantMessageId: opts.assistantMessageId ?? null,
        judgeModel: opts.judgeModel ?? null,
      });
    } catch {
      return null;
    }
  }

  /**
   * 阶段 B：fabrication 语义裁判（独立辅助函数）。
   * 两档门控命中 + judgeModel 可用 → 构造证据摘要 → judgeFabrication → 命中阈值回写 fabricationSuspected。
   */
  async function runFabricationJudgeStage(
    all: ToolExecutionRow[],
    verdict: ReturnType<typeof evaluateHarness>,
    args: {
      content: string;
      sinceIso: string | null;
      actualToolCallCount: number;
      finishReason: string;
      assistantMessageId: string | null;
      judgeModel: import("@/lib/llm/provider-factory").LanguageModel | null;
    },
  ) {
    const gate = classifyFabricationGate({
      regexClean: true,
      finishReason: args.finishReason,
      toolCallCount: args.actualToolCallCount,
      content: args.content,
    });
    if (gate === false) return verdict;
    if (!args.judgeModel) return verdict;

    const rowsForMessage = selectRowsForMessage(all, {
      assistantMessageId: args.assistantMessageId,
      sinceIso: args.sinceIso,
    });
    const summary = buildFabricationEvidenceSummary(rowsForMessage);
    const judgement = await judgeFabrication(args.content, args.judgeModel, summary);
    if (judgement.fabricated && judgement.confidence >= FABRICATION_CONFIDENCE_THRESHOLD) {
      return {
        ...verdict,
        fabricationSuspected: {
          claimedActions: judgement.claimedActions,
          reason: judgement.reason,
        },
      };
    }
    return verdict;
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
        } catch (err) {
          // 落库不可用时降级为纯内存——但必须让用户知道，否则就是本次事故复现：
          // 屏幕上一切正常，重启后这段对话彻底消失，且没有任何痕迹能回溯原因。
          console.error("[handleSend] getOrCreateMainChat failed, falling back to memory-only", err);
          setPersistNotice(t("chat.persistFailed"));
        }
      }
      if (stopIfAborted()) return null;
      if (convId) {
        try {
          userId = (await dbMessages.create({ conversationId: convId, role: "user", content: text, attachments: attachments?.length ? JSON.stringify(attachments) : null })).id;
        } catch (err) {
          // 写库失败降级用内存 id——同上，必须可见
          console.error("[handleSend] user message persist failed, falling back to memory-only", err);
          setPersistNotice(t("chat.persistFailed"));
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
        toolCallCount?: number | null,
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
            toolCallCount: toolCallCount ?? null,
          })
          .catch((err) => {
            console.error("[persistAssistant] assistant message persist failed", err);
            setPersistNotice(t("chat.persistFailed"));
          });
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
              // 2026-07-04 补：降权这一半——用这次纠正之前的样例池，找出真正"投票"给
              // 错误 action 的那条样例，权重打折（跟下面"加权"对称，形成完整闭环）。
              const examplesBeforeCorrection = [
                ...BUILTIN_INTENT_EXAMPLES,
                ...(await intentLearning.listExamples({ enabledOnly: true })),
              ];
              await downweightMisjudgedExampleInDb(text, correction.predictedAction, examplesBeforeCorrection).catch(() => {});
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

          // L9 意图识别细节面板（开发者模式可见）：记录本轮决策 + 复用 judge 内部已算好的 semanticRoute。
          // M1 修复（2026-07-09）：decision.semanticRoute 是 classifyTurnIntentWithJudge 内部算过的
          // 同一份路由结果，直接读取，不再重复调 routeTurnIntentSemantically（省一次
          // keywordEmbed + 逐样例余弦相似度）；只有 cancel_run/pause_run 走 L0 硬规则短路时
          // decision.semanticRoute 才是 undefined，这种情况仍需现算一次（罕见路径，可接受）。
          // L4 修复（2026-07-09）：写入也挂 developerDiagnosticsEnabled 开关，跟组件渲染保持
          // 一致——普通用户没打开过开发者诊断，就不该悄悄攒着这份调试数据。
          // try/catch 隔离，诊断失败绝不阻断主对话（参考 v3.4 §0.3 产物纪律 + "别把代码堆回大文件"）。
          try {
            if (isDeveloperDiagnosticsEnabled()) {
              const diagnosticRoute =
                decision.semanticRoute ??
                routeTurnIntentSemantically(
                  text,
                  learnedExamples.length
                    ? [...BUILTIN_INTENT_EXAMPLES, ...learnedExamples]
                    : BUILTIN_INTENT_EXAMPLES,
                );
              appendIntentDiagnostics({
                id: crypto.randomUUID(),
                capturedAt: new Date().toISOString(),
                userTextExcerpt: text.length > 80 ? `${text.slice(0, 80)}…` : text,
                decision,
                route: diagnosticRoute,
              });
            }
          } catch {
            // ignore
          }

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
      } = prep;
      const explicitDebateRequest =
        turnIntentDecision?.patch?.debateRequested === true ||
        isExplicitDebateRequest(text);
      const shouldRunDebateTurn =
        !pureMode &&
        explicitDebateRequest;
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
      setPersistNotice(null);

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
        setDebateParticipants(
          participants.map((p) => {
            const found = getAvailableModels().find((m) => m.id === p.modelId);
            return { modelId: p.modelId, modelName: found?.displayName || found?.name || p.modelName };
          }),
        );

        const topic = buildDebateTopic({ messages, userMessage: userMsg });
        const result = await runDynamicDebate({ topic, participants, maxParticipants: 4, maxIterations: 2, signal: controller.signal }, realRunRole);
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
          const fullDebate = isFullDebateResult(result);
          const nextWorkflow = completeCurrentWorkflowNode({
            snapshot: activeSnapshot,
            summary: result.finalSolution.slice(0, 1200),
            planSource: {
              kind: fullDebate ? "debate_result" : "degraded_debate",
              ref: `debate:${activeRunId}`,
              summary: result.finalSolution.slice(0, 1200),
              phase: "debate",
              boundAt: new Date().toISOString(),
              label: fullDebate ? "完整多模型博弈结果" : "多模型博弈未完成后的降级方案",
            },
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
        setDebateParticipants(null);
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
      setPersistNotice(null);

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
        intentJudgeModel,
        turnWorkflowSnapshot,
        turnWorkflowRunId,
        shouldCompleteWorkflowNode,
      } = prep;
      let activeTurnWorkflowSnapshot = turnWorkflowSnapshot;

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
          pureMode,
        });
      } catch (err) {
        setStreamError(err instanceof Error ? err.message : t("chat.constructError"));
        cleanupStoppedTurn();
        return;
      }

      let tools: WorkspaceToolRuntime["tools"];
      let workspacePreamble: string | null = null;
      let workflowPreamble: string | null = null;
      let skillPreamble: string | null = null;
      let projectMemoryPreamble: string | null = null;
      let crossProjectPreamble: string | null = null;
      let effectivePermissionMode = permissionMode;

      const insertWriteGuardNotice = () => {
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
      };

      if (
        impliesWriteIntent({ text, decision: cacheIntent }) &&
        (!effectiveWorkspace || permissionMode === "read")
      ) {
        const alreadyPrompted = convId ? escalationPromptedRef.current.has(convId) : true;
        // 只在"绑了工作区 + 当前只读 + 这个会话还没问过"时主动弹窗——没绑工作区没法靠切权限解决
        // （还得先选文件夹），问过一次就不再重复打扰，退化回旧的文字提示。
        if (effectiveWorkspace && permissionMode === "read" && escalatePermission && !alreadyPrompted) {
          if (convId) escalationPromptedRef.current.add(convId);
          const escalated = await escalatePermission();
          if (escalated) {
            effectivePermissionMode = "confirm";
          } else {
            insertWriteGuardNotice();
          }
        } else {
          insertWriteGuardNotice();
        }
      }

      const includeWriteTools = shouldExposeWriteTools(effectivePermissionMode);
      const desktopPath = await desktopDir().catch(() => null);

      if (effectiveWorkspace) {
        if (primaryIsCli) {
          workspacePreamble = await buildWorkspacePreamble(effectiveWorkspace, { includeWrite: includeWriteTools, desktopPath: includeWriteTools ? desktopPath : null });
          if (stopIfAborted()) return;
        } else {
          const runtime = await prepareWorkspaceToolRuntime({
            workspacePath: effectiveWorkspace,
            includeWrite: includeWriteTools,
            conversationId: convId ?? undefined,
            // 2026-07-04 修复：把这一轮真正生成的 assistant 消息 id 传下去，工具执行审计
            // 落库时带上它，UI 侧才能按真实消息分组工具卡片，不再靠时间戳窗口瞎猜、
            // 把编排模式下其他节点的工具调用张冠李戴到这条消息上。
            messageId: assistantId,
            confirm: effectivePermissionMode === "auto" ? async () => true : requestConfirm,
            approveMcpLaunch: (server, workspacePath) => requestConfirm({
              toolName: `mcp-server:${server.name}`,
              summary: `允许启动本地 MCP server？\n${formatLocalMcpLaunch(server, workspacePath)}`,
            }),
            askUser: requestAskUser,
            includePreamble: true,
            desktopPath: includeWriteTools ? desktopPath : null,
          });
          if (stopIfAborted()) return;
          tools = runtime.tools;
          workspacePreamble = runtime.workspacePreamble;
        }
      } else if (!primaryIsCli) {
        // 2026-07-05 修复：没绑工作区时，文件/命令类工具确实没有根目录可用，但 web_fetch（联网）
        // 和 remember（记忆）不依赖 workspacePath，不该被"没绑文件夹"连坐一起消失——
        // 纯聊天模式下模型也该能上网查资料。CLI 引擎走自己的真实工具，不需要这条兜底。
        const runtime = await prepareWorkspaceToolRuntime({
          includeWrite: false,
          conversationId: convId ?? undefined,
          messageId: assistantId,
          confirm: effectivePermissionMode === "auto" ? async () => true : requestConfirm,
          approveMcpLaunch: (server, workspacePath) => requestConfirm({
            toolName: `mcp-server:${server.name}`,
            summary: `允许启动本地 MCP server？\n${formatLocalMcpLaunch(server, workspacePath)}`,
          }),
          askUser: requestAskUser,
        });
        if (stopIfAborted()) return;
        tools = runtime.tools;
      }

      const desktopPlan = await readDesktopPlanForExecution({
        userText: text,
        desktopPath,
        fs: getFsAdapter(),
      });
      if (desktopPlan && convId && activeTurnWorkflowSnapshot && turnWorkflowRunId) {
        const nextWorkflow = attachPlanSourceToWorkflow({
          snapshot: activeTurnWorkflowSnapshot,
          summary: desktopPlan.content.slice(0, 1200),
          source: {
            kind: "file",
            ref: desktopPlan.path,
            summary: desktopPlan.content.slice(0, 1200),
            phase: "plan",
            boundAt: new Date().toISOString(),
            label: "用户桌面方案文件",
          },
        });
        await workflowRuns.saveSnapshot({
          runId: turnWorkflowRunId,
          snapshot: nextWorkflow,
          eventType: "workflow.plan_source_attached",
          eventPayload: { path: desktopPlan.path },
        }).catch(() => {});
        activeTurnWorkflowSnapshot = nextWorkflow;
        applyWorkflowSnapshot(nextWorkflow);
      }
      workflowPreamble = buildWorkflowContextPreamble({
        snapshot: activeTurnWorkflowSnapshot,
        userText: text,
        desktopPlan,
      });

      const selectedSkill = selectSkillForTurn({
        text,
        workflowSnapshot: activeTurnWorkflowSnapshot,
        intentDecision: cacheIntent,
      });
      if (selectedSkill && convId && activeTurnWorkflowSnapshot && turnWorkflowRunId) {
        const nextWorkflow = attachActiveSkillToWorkflow({
          snapshot: activeTurnWorkflowSnapshot,
          skill: selectedSkill,
        });
        await workflowRuns.saveSnapshot({
          runId: turnWorkflowRunId,
          snapshot: nextWorkflow,
          eventType: "workflow.skill_selected",
          eventPayload: { skillId: selectedSkill.id, reason: selectedSkill.reason },
        }).catch(() => {});
        activeTurnWorkflowSnapshot = nextWorkflow;
        applyWorkflowSnapshot(nextWorkflow);
      }
      skillPreamble = buildSkillPreamble(selectedSkill);

      const currentProjectId =
        (convId ? conversationList.find((c) => c.id === convId)?.projectId : null) ?? null;
      if (currentProjectId && !pureMode) {
        try {
          const [{ preamble }, project, memories] = await Promise.all([
            retrieveCrossProjectMemoriesForPrompt(currentProjectId, text),
            dbProjects.getById(currentProjectId),
            retrieveProjectMemoriesForPrompt(currentProjectId, text),
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
        workflowPreamble,
        skillPreamble,
        tooLargeNotice,
        modelLabel: model.displayName ?? model.name,
      });
      // v0.9.1 摘要式压缩：async + 失败退回抽取式（绝不阻断发送）
      // 注意：await 必须在 outgoing = compressedPrompt.messages 之前，
      // 否则 outgoing 会拿到一个未 resolve 的 Promise，后续 convo = outgoing 直接坏掉。
      //
      // summarizeModel 复用 intentJudgeModel：当前项目里"已经跑起来的辅助模型解析入口"
      // 就是 intent-judge 路径（line 344-351）。如果将来想用更便宜的模型做摘要（而非主对话
      // 模型），可以新建 SmartRouter util 角色解析——现在先用 intentJudgeModel 把链路接通，
      // 让 history-summarizer / conversation_summaries 不再是死代码。
      const compressedPrompt = await applyPromptCompressionWithSummary({
        enabled: smart,
        messages: outgoing,
        modelName: model.name,
        contextWindow: model.contextWindow,
        noticeText: (n) => t("chat.contextTrimmed", { count: n }),
        summarizeModel: intentJudgeModel ?? undefined,
        persistence: convId
          ? {
              conversationId: convId,
              modelId: model.id,
              // tokenCount 留给将来 fingerprint 算法决策时再计算
              tokenCount: null,
            }
          : undefined,
      });
      outgoing = compressedPrompt.messages;
      const compressionStats = compressedPrompt.compressionStats;

      const MAX_HARNESS_RETRY = 1;
      // 客观写意图信号（2026-07-07，Haiku 4.5 "现在真正保存。等待权限提示" 却 0 工具调用的真修法）：
      // nudge 原来只靠 detectIntentNoToolCall(检测模型正文话术) 触发——话术千变万化，是打地鼠。
      // 这里并联一条不依赖话术的客观信号：用户**这轮原始消息**就明显要写文件/执行
      // （impliesWriteIntent，已排除纯软文写作），那么"有 write 工具却 0 工具调用就正常结束"
      // 几乎必然是没动手。不管模型嘴上说什么（甚至什么都不解释），都触发强制 toolChoice 重答。
      const turnImpliesWrite = impliesWriteIntent({ text, decision: cacheIntent });
      const streamingState = createStreamingTurnState(model.id);
      let convo = outgoing;
      let finalContent = "";
      // harness/nudge 重答光靠纠正话术里"请真正调用工具"这句文字不够硬——模型完全可能继续
      // 嘴炮或换个说法蒙混过关。两种重答只要本轮挂了工具，都在下一次尝试直接在 API 层锁死
      // toolChoice:"required"，不给它"继续不调用工具"这个选项（见 stream-retry.ts）。
      let forceToolChoiceRequired = false;
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
              ...(tools
                ? { tools, maxToolSteps: 12, ...(forceToolChoiceRequired ? { toolChoice: "required" as const } : {}) }
                : {}),
            },
          );
          streamingState.lastResultModelId = result.usedModelId;
          if (controller.signal.aborted) break;

          const verdict = await evalHarnessForConversation(
            convId,
            streamingState.fullContent,
            turnStartedAt,
            streamingState.lastToolCallCount,
            {
              assistantMessageId: assistantId,
              finishReason: streamingState.lastFinishReason,
              judgeModel: intentJudgeModel,
            },
          );
          const harnessDirty = !!(verdict && !isClean(verdict));
          const nudgeNeeded =
            !harnessDirty &&
            !!tools &&
            streamingState.lastFinishReason === "stop" &&
            streamingState.lastToolCallCount === 0 &&
            (detectIntentNoToolCall(streamingState.fullContent) || turnImpliesWrite);

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
            forceToolChoiceRequired = retryDecision.forceToolChoice;
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
                  ? {
                      ...m,
                      harness: {
                        unverifiedPaths: verdict!.unverifiedPaths,
                        unverifiedUrls: verdict!.unverifiedUrls,
                        unverifiedCommands: verdict!.unverifiedCommands,
                        pseudoToolNames: verdict!.pseudoToolNames,
                        fabricatedUsageCount: verdict!.fabricatedUsageCount ?? null,
                        fabricationSuspected: verdict!.fabricationSuspected ?? null,
                      },
                    }
                  : m,
              ),
            );
          }
          break;
        }
        finalContent = streamingState.fullContent;
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, toolCallCount: streamingState.lastToolCallCount } : m)),
        );
        prep.persistAssistant(
          streamingState.fullContent,
          streamingState.lastModelId,
          streamingState.lastUsage,
          undefined,
          streamingState.lastToolCallCount,
        );
        if (convId && shouldCompleteWorkflowNode && activeTurnWorkflowSnapshot && turnWorkflowRunId && streamingState.fullContent && !controller.signal.aborted) {
          try {
            const nextWorkflow = completeCurrentWorkflowNode({
              snapshot: activeTurnWorkflowSnapshot,
              summary: streamingState.fullContent.slice(0, 1200),
            });
            await workflowRuns.saveSnapshot({
              runId: turnWorkflowRunId,
              snapshot: nextWorkflow,
              eventType: "workflow.node_completed",
              eventPayload: {
                nodeId: activeTurnWorkflowSnapshot.currentNodeId,
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
        // 修复（2026-07-05）：unknown/tool_budget_exhausted 落到这一步时，userMessage 本身
        // 信息量很低（"对话失败，请稍后重试"），而 technicalMessage 早就算出来了却被扔掉——
        // 用户看到空话，连自己是撞了哪种真实错误都无从判断。这两类无信息量兜底才追加技术详情，
        // 其余分类（auth_invalid/rate_limit 等）userMessage 已经讲清楚原因，不需要再堆技术文本。
        // 修复（2026-07-07，用户实测发现）：CLI 引擎（claude-cli/codex-cli）的分类走的是
        // 子进程 stderr 原文关键词匹配（见 error-classifier.ts），置信度天生不如 API 直连的
        // 真实 HTTP 状态码——实测出现过 CLI 本身在终端能正常登录对话，但 app 里因为
        // --resume 一类执行细节被误判成 auth_invalid 的情况。CLI 来源的错误一律追加原始
        // stderr，不然连是不是误判都无从判断。
        const classified = classifyLlmError(err, t);
        const isCliError = typeof err === "object" && err !== null && "__cliKind" in err;
        const lowInfo =
          classified.category === "unknown" ||
          classified.category === "tool_budget_exhausted" ||
          isCliError;
        setStreamError(
          lowInfo && classified.technicalMessage
            ? `${classified.userMessage}（${classified.technicalMessage}）`
            : classified.userMessage,
        );
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
        intentJudgeModel,
      } = prep as Awaited<ReturnType<typeof prepareTurn>> & {
        intentJudgeModel: import("@/lib/llm/provider-factory").LanguageModel | null;
      };
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
              judgeModel: intentJudgeModel,
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
            leaderModelId: getSelectedModelId(),
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
      /** fabrication 语义裁判用的辅助模型（与主对话 evalHarnessForConversation 共用同一入口） */
      judgeModel: import("@/lib/llm/provider-factory").LanguageModel | null;
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
        // 当前跳的 message id（每次 onRoleStart 刷新）——给 harnessCheck 用，让 fabrication judge
        // 能按 messageId 优先归属工具证据，避免时间窗口误借到其他跳/其他对话的记录
        const chainCurrentMessageIdRef: { current: string | null } = { current: null };
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
          getCurrentMessageId: () => chainCurrentMessageIdRef.current,
          harnessCheck: async ({ content, startedAt, toolCallCount, finishReason, assistantMessageId }) => {
            // 团队负责人链路：等价于主对话（防编造 §5.3）——assemble 两档门控 + 证据摘要
            return evalHarnessForConversation(args.conversationId, content, startedAt, toolCallCount, {
              assistantMessageId: assistantMessageId ?? null,
              finishReason,
              judgeModel: args.judgeModel,
            });
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
              chainCurrentMessageIdRef.current = id; // 刷新当前跳的 messageId 给 harnessCheck 用
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
    debateParticipants,
    drainingRef,
    handleSend,
    handleStop,
    harnessNotice,
    lastUsage,
    messages,
    pendingQueue,
    persistNotice,
    setLastUsage,
    setMessages,
    setPendingQueue,
    setStreamElapsedMs,
    setStreamError,
    setHarnessNotice,
    setSwitchNotice,
    setCacheNotice,
    setPersistNotice,
    streamElapsedMs,
    streamError,
    switchNotice,
  };
}
