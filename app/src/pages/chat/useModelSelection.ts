import { useCallback, useEffect, useRef, useState, type RefObject, type MutableRefObject } from "react";
import type { TFunction } from "i18next";
import { models as dbModels, apiCredentials as dbCredentials, conversations as dbConversations } from "@/lib/db";
import { type ModelListItem, type CredentialListItem } from "@/lib/api";
import { isSmartRoutingEnabled } from "@/lib/app-settings";
import { pickBestModelForRole, scoreModelForRole } from "@/lib/llm/model-capabilities";
import { routeMessage } from "@/lib/llm/smart-router";
import { applyOutcomeForLatest } from "@/lib/llm/outcome-tracker";
import {
  pinModelToCurrentNode,
  serializeOrchestration,
  type OrchestrationState,
} from "@/lib/llm/orchestrator";
import type { ChatMessage } from "./types";

/** SmartRouter 在 handleSmartPick 里写、handleSend 读的路由决策镜像（避免 stale closure）。 */
export interface PendingRoutingDecision {
  prompt: string;
  baselineModelId: string;
  baselineModelName: string;
  baselineProviderType?: string | null;
  actualModelId: string;
}

interface AlertOptions {
  title: string;
  description: string;
}

export interface UseModelSelectionOptions {
  // 跨 hook 读（ref 镜像避免 stale closure）
  conversationId: string | null;
  messages: ChatMessage[];
  orchestrationRef: MutableRefObject<OrchestrationState | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  pendingRoutingDecisionRef: MutableRefObject<PendingRoutingDecision | null>;
  active: boolean;

  // 跨 hook 写（按范式回调注入，不直接调外部 setter）
  applyOrchestration: (next: OrchestrationState | null) => void;
  setSwitchNotice: (message: string | null) => void;
  /** 用户手动切模型时同步会话默认模型（ChatPage 改 conversationList + 写库） */
  onConversationDefaultModelChanged: (newModelId: string) => void;

  // 业务依赖
  alert: (opts: AlertOptions) => Promise<void>;
  t: TFunction;
}

/** hook B：模型选择。持 availableModels / credentials / selectedModelId，
 *  提供 loadModelsAndCreds / handleModelChange / handleSmartPick。 */
export function useModelSelection({
  conversationId,
  messages,
  orchestrationRef,
  inputRef,
  pendingRoutingDecisionRef,
  active,
  applyOrchestration,
  setSwitchNotice,
  onConversationDefaultModelChanged,
  alert,
  t,
}: UseModelSelectionOptions) {
  const [availableModels, setAvailableModels] = useState<ModelListItem[]>([]);
  const [credentials, setCredentials] = useState<CredentialListItem[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");

  // 切回聊天页时刷新模型列表（首次激活由挂载 effect 负责，这里跳过避免重复拉取）
  const activatedOnceRef = useRef(false);

  const loadModelsAndCreds = useCallback(async (): Promise<ModelListItem[]> => {
    const [modelsRes, credsRes] = await Promise.all([
      dbModels.listEnabled(),
      dbCredentials.list(),
    ]);
    const ml = modelsRes.map((m) => ({
      id: m.id,
      name: m.name,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      inputPrice: m.inputPrice,
      outputPrice: m.outputPrice,
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
  }, []);

  // active prop 触发重新加载（首次激活跳过）
  useEffect(() => {
    if (!active) return;
    if (!activatedOnceRef.current) {
      activatedOnceRef.current = true;
      return;
    }
    void loadModelsAndCreds().catch(() => {});
  }, [active, loadModelsAndCreds]);

  // 隐式信号采集（改进-1 Step B）：用户在已有对话里手动换到能力分更高的模型，
  // 说明上一个模型这次没让他满意（路由派轻了）→ 给上个模型记一条 switched_up 负反馈，喂回评分。
  const handleModelChange = useCallback((newId: string) => {
    const oldId = selectedModelId;
    setSelectedModelId(newId);
    onConversationDefaultModelChanged(newId);

    // 用户手动接管：把这个模型钉到当前节点，编排后续不再自动覆盖它
    const state = orchestrationRef.current;
    if (state && state.currentNodeId) {
      const pinned = pinModelToCurrentNode(state, newId);
      applyOrchestration(pinned);
      if (conversationId) {
        void dbConversations
          .saveOrchestration(conversationId, serializeOrchestration(pinned))
          .catch(() => {});
      }
    }

    if (!oldId || oldId === newId || messages.length === 0) return;
    const oldM = availableModels.find((m) => m.id === oldId);
    const newM = availableModels.find((m) => m.id === newId);
    if (oldM && newM && scoreModelForRole(newM, "main_chat") > scoreModelForRole(oldM, "main_chat")) {
      void applyOutcomeForLatest(oldId, "switched_up");
    }
  }, [
    selectedModelId,
    orchestrationRef,
    applyOrchestration,
    conversationId,
    messages,
    availableModels,
    onConversationDefaultModelChanged,
  ]);

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
          const currentModel = currentId ? availableModels.find((m) => m.id === currentId) : null;
          setSelectedModelId(routed.model.id);
          pendingRoutingDecisionRef.current =
            currentModel && currentModel.id !== routed.model.id
              ? {
                  prompt: text,
                  baselineModelId: currentModel.id,
                  baselineModelName: currentModel.name,
                  baselineProviderType: currentModel.provider?.type ?? null,
                  actualModelId: routed.model.id,
                }
              : null;
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

  return {
    availableModels,
    credentials,
    handleModelChange,
    handleSmartPick,
    loadModelsAndCreds,
    selectedModelId,
    setSelectedModelId,
  };
}
