import type { ToolCallView } from "@/lib/work-artifact-views";
import type { ChatMessage } from "./types";

/**
 * 把工具调用归属到对应那一轮的 assistant 消息。
 *
 * 2026-07-04 修复（重大）：优先按真实 messageId 精确归属，不再靠时间戳窗口猜。
 * 根因：旧实现窗口 = [该 assistant 的 createdAt, 其后第一条带时间戳消息的 createdAt)，
 * 但"最新一条消息"永远没有下一条消息，窗口右边界是 null（无限开放）——编排/多角色接力
 * 场景下，任何在这条消息之后由其他节点/其他角色执行的工具调用都会被无条件"认领"到这条
 * 可见消息上，造成工具卡片张冠李戴（真实事故：某次后台节点真的写文件成功，但因为这个
 * bug，卡片被显示在了另一条本轮 0 工具调用的可见消息上，导致 harness 自查把"这条消息自己
 * 没调工具"误判成"这件事根本没发生"，反而否认了一次真实成功的操作）。
 *
 * 只有 messageId 缺失的历史行（迁移前旧数据）才退回时间戳窗口兜底，且兜底池只包含同样
 * 缺 messageId 的行，不会被已经有真实归属的新行污染。
 */
export function deriveToolCallsByMessage(
  messages: readonly ChatMessage[],
  toolCallViews: readonly ToolCallView[],
): Map<string, ToolCallView[]> {
  const map = new Map<string, ToolCallView[]>();
  const withMessageId = toolCallViews.filter((tc) => tc.messageId !== null);
  const legacyRows = toolCallViews.filter((tc) => tc.messageId === null);

  const byMessageId = new Map<string, ToolCallView[]>();
  for (const tc of withMessageId) {
    const list = byMessageId.get(tc.messageId!) ?? [];
    list.push(tc);
    byMessageId.set(tc.messageId!, list);
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || m.kind === "receipt") continue;

    const exact = byMessageId.get(m.id);
    if (exact) {
      map.set(m.id, exact);
      continue;
    }

    // 兜底：只在没有任何真实 messageId 匹配时才用时间戳窗口猜（legacyRows 专用池）
    if (!m.createdAt) {
      map.set(m.id, []);
      continue;
    }
    const start = m.createdAt;
    let end: string | null = null;
    for (let j = i + 1; j < messages.length; j++) {
      const c = messages[j]!.createdAt;
      if (c) {
        end = c;
        break;
      }
    }
    map.set(
      m.id,
      legacyRows.filter((tc) => tc.createdAt >= start && (end === null || tc.createdAt < end)),
    );
  }
  return map;
}
