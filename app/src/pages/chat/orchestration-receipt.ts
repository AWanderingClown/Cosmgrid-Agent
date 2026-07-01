import type { TFunction } from "i18next";
import type { ModelListItem } from "@/lib/api";
import type { OrchestrationChange, OrchestrationState } from "@/lib/llm/orchestrator";
import type { ReceiptContent } from "./types";

export function buildOrchestrationReceipt(args: {
  change: OrchestrationChange;
  next: OrchestrationState;
  prev: OrchestrationState | null;
  reason: string;
  availableModels: ModelListItem[];
  t: TFunction;
}): ReceiptContent | null {
  const { change, next, prev, reason, availableModels, t } = args;
  const node = change.node;
  if (!node) return null;
  const nameOf = (id: string | null) =>
    (id ? availableModels.find((m) => m.id === id)?.displayName ?? availableModels.find((m) => m.id === id)?.name : null) ?? null;
  const nodeLabel = t(`chat.orchestrator.roles.${node.role}`);
  const modelName = nameOf(node.modelId) ?? t("chat.orchestrator.receiptNoModel");
  let summary: string;
  if (!prev) {
    summary = t("chat.orchestrator.receiptPlanned", { count: next.nodes.length, node: nodeLabel, model: modelName });
  } else if (change.nodeChanged) {
    summary = t("chat.orchestrator.receiptEntered", { node: nodeLabel, model: modelName });
  } else {
    summary = t("chat.orchestrator.receiptSwitched", { node: nodeLabel, model: modelName });
  }
  const nodesList = next.nodes
    .map((n) => {
      const mk = nameOf(n.modelId);
      const mark = n.id === next.currentNodeId ? "▸ " : "· ";
      return `${mark}${t(`chat.orchestrator.roles.${n.role}`)}：${n.title}${mk ? ` — ${mk}` : ""}`;
    })
    .join("\n");
  const detail = `${t("chat.orchestrator.receiptReason", { reason })}\n\n${t("chat.orchestrator.detailNodes")}：\n${nodesList}`;
  return { summary, detail };
}
