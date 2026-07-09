import type { IntentDiagnosticsEntry, IntentDecisionLayer } from "@/lib/workflow/intent-diagnostics-buffer";
import type { TurnAction, TurnIntentDecision } from "@/lib/workflow/types";
import type { IntentRouteAction } from "@/lib/workflow/semantic-intent-router";

/**
 * 意图识别细节面板的展示项派生。
 *
 * 纯函数 + 不调外部副作用——可单测、可 React 缓存。
 * 输入是 buffer 里的 entry（已经包含 judge 返回的 decision + 我自己跑的 router 结果），
 * 输出是组件可直接渲染的字段。
 */

export interface IntentDiagnosticsRow {
  readonly id: string;
  readonly capturedAt: string;
  readonly userTextExcerpt: string;
  readonly layer: IntentDecisionLayer;
  readonly layerLabel: string;
  readonly actionLabel: string;
  readonly confidenceText: string;
  readonly reasonText: string;
  readonly matchedExampleText: string | null;
  readonly patchSummary: string | null;
  readonly stateMachineAccepted: boolean;
}

const ACTION_LABELS: Record<TurnAction | IntentRouteAction, string> = {
  answer_only: "普通对话",
  start_run: "开始任务",
  continue_run: "继续任务",
  plan: "方案计划",
  review: "评审",
  debate: "多模型博弈",
  execute: "执行",
  verify: "验证",
  reject_node: "打回",
  pause_run: "暂停",
  cancel_run: "取消",
  approve_node: "放行执行",
  modify_run: "调整任务",
  resume_run: "恢复任务",
};

const LAYER_LABELS: Record<IntentDecisionLayer, string> = {
  "L0-rule": "L0 硬规则",
  "L1-semantic": "L1 语义路由",
  "L2-judge": "L2 LLM 裁判",
  "L3-state-machine": "L3 状态机门控",
  unknown: "未知层",
};

export function inferIntentLayer(entry: IntentDiagnosticsEntry): IntentDecisionLayer {
  const { decision, route } = entry;
  if (decision.action === "cancel_run" || decision.action === "pause_run") {
    return "L0-rule";
  }
  if (route.noMatch || !route.top) {
    return "L2-judge";
  }
  const decisionAction: IntentRouteAction | null =
    decision.action === "approve_node"
      ? "execute"
      : decision.action === "modify_run"
        ? null
        : (decision.action as IntentRouteAction);
  const routeMatchedDecision = decisionAction !== null && route.top.action === decisionAction;
  if (routeMatchedDecision && route.confidence >= 0.64) {
    return "L1-semantic";
  }
  return "L2-judge";
}

export function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return "—";
  return `${Math.round(confidence * 100)}%`;
}

function summarizePatch(patch: IntentDiagnosticsEntry["decision"]["patch"]): string | null {
  if (!patch) return null;
  const parts: string[] = [];
  if (patch.objective) parts.push(`目标=${patch.objective.slice(0, 24)}`);
  if (patch.requestedOutcome) parts.push(`结果=${patch.requestedOutcome.slice(0, 24)}`);
  if (patch.executionMode) parts.push(`模式=${patch.executionMode}`);
  if (patch.reviewRequested) parts.push("请求评审");
  if (patch.debateRequested) parts.push("请求对弈");
  if (patch.verificationRequired) parts.push("请求验证");
  if (patch.securitySensitive) parts.push("高敏感");
  if (patch.needsWorkspace) parts.push("需要工作区");
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * 状态机门控是否放行本次决策。
 * 判定口径：
 * - targetRunId 非空 → 决策已绑定到具体 run（reducer 已通过）；
 * - action 为 start_run → 创建新 run，不需要 targetRunId；
 * - action 为 answer_only → 普通对话不进入工作流，等同"放行"（无 workflow 可挡）。
 * 其余情况（continue_run / approve_node 等没有 targetRunId）一律视为被状态机门控挡掉。
 */
function isStateMachineAccepted(decision: TurnIntentDecision): boolean {
  return decision.targetRunId !== null
    || decision.action === "start_run"
    || decision.action === "answer_only";
}

export function deriveIntentDiagnosticsRow(
  entry: IntentDiagnosticsEntry,
): IntentDiagnosticsRow {
  const layer = inferIntentLayer(entry);
  const actionLabel = ACTION_LABELS[entry.decision.action] ?? entry.decision.action;
  const matchedExampleText = entry.route.top
    ? `${entry.route.top.matchedExample.text} · score=${entry.route.top.score.toFixed(2)}`
    : null;
  return {
    id: entry.id,
    capturedAt: entry.capturedAt,
    userTextExcerpt: entry.userTextExcerpt,
    layer,
    layerLabel: LAYER_LABELS[layer],
    actionLabel,
    confidenceText: formatConfidence(entry.decision.confidence),
    reasonText: entry.decision.reason,
    matchedExampleText,
    patchSummary: summarizePatch(entry.decision.patch),
    stateMachineAccepted: isStateMachineAccepted(entry.decision),
  };
}

export function deriveIntentDiagnosticsRows(
  entries: readonly IntentDiagnosticsEntry[],
): IntentDiagnosticsRow[] {
  return entries.map(deriveIntentDiagnosticsRow);
}
