import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import { messages as dbMessages } from "@/lib/db";
import type { ModelListItem } from "@/lib/api";
import type { OrchestrationChange, OrchestrationState } from "@/lib/llm/orchestrator";
import type { ChatMessage, ReceiptContent } from "./types";

export function buildOrchestrationReceipt(args: {
  change: OrchestrationChange;
  next: OrchestrationState;
  prev: OrchestrationState | null;
  reason: string;
  availableModels: ModelListItem[];
  /**
   * leader 角色的模型永远不接受编排系统覆盖（用户手选优先，见 orchestrator.ts 设计），
   * 实际跑的是这个 id——回执文案必须显示它，而不是编排算出来但从不生效的 node.modelId，
   * 否则会出现"回执说规划用了 Claude，顶部/工作面板却还是 MiniMax"这种文案跟实际执行对不上
   * 的显示 bug（2026-07-04 修复）。
   */
  leaderModelId: string;
  t: TFunction;
}): ReceiptContent | null {
  const { change, next, prev, reason, availableModels, leaderModelId, t } = args;
  const node = change.node;
  if (!node) return null;
  const nameOf = (id: string | null) =>
    (id ? availableModels.find((m) => m.id === id)?.displayName ?? availableModels.find((m) => m.id === id)?.name : null) ?? null;
  const resolvedModelId = (n: { role: string; modelId: string | null }) =>
    n.role === "leader" ? leaderModelId : n.modelId;
  const nodeLabel = t(`chat.orchestrator.roles.${node.role}`);
  const modelName = nameOf(resolvedModelId(node)) ?? t("chat.orchestrator.receiptNoModel");
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
      const mk = nameOf(resolvedModelId(n));
      const mark = n.id === next.currentNodeId ? "▸ " : "· ";
      return `${mark}${t(`chat.orchestrator.roles.${n.role}`)}：${n.title}${mk ? ` — ${mk}` : ""}`;
    })
    .join("\n");
  const detail = `${t("chat.orchestrator.receiptReason", { reason })}\n\n${t("chat.orchestrator.detailNodes")}：\n${nodesList}`;
  return { summary, detail };
}

export async function appendOrchestrationReceiptMessage(args: {
  conversationId: string;
  receipt: ReceiptContent;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}) {
  let noteId: string = crypto.randomUUID();
  try {
    noteId = (await dbMessages.create({
      conversationId: args.conversationId,
      role: "note",
      content: JSON.stringify(args.receipt),
    })).id;
  } catch {
    // 回执落库失败仍在内存里展示
  }
  args.setMessages((prev) => [
    ...prev,
    { id: noteId, role: "assistant", content: "", kind: "receipt", receipt: args.receipt },
  ]);
}
