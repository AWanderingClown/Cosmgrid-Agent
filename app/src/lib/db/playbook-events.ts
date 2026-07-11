// Harness 工程实施计划 阶段5 — memory_playbook_events 表 DAO。
//
// Event Sourcing 模式：Reflector 周期消费 PlaybookEvent 转化为 PlaybookCandidate。
// 5 种事件类型：tool_success / tool_error / checkpoint_failed / summary_dropped /
// outcome_passed / outcome_failed / outcome_needs_user。
//
// 写入路径（旁路 try/catch，不阻塞主对话流）：
// - chat-fallback onUsage 后 → recordPlaybookEvent(tool_success / tool_error)
// - stream-finalization 节点完成 → recordPlaybookEvent(outcome_*)
// - context-compressor 摘要截断 → recordPlaybookEvent(summary_dropped)
// - checkpoint-generator 失败 → recordPlaybookEvent(checkpoint_failed)

import { getDb } from "./connection";
import { newId, now } from "./utils";
import type { PlaybookEventKind } from "@/lib/llm/playbook/types";

export interface PlaybookEventRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  messageId: string | null;
  kind: PlaybookEventKind;
  payloadJson: string;
  occurredAt: string;
  createdAt: string;
}

function rowToPlaybookEvent(r: any): PlaybookEventRow {
  return {
    id: r.id,
    projectId: r.project_id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    kind: r.kind,
    payloadJson: r.payload_json,
    occurredAt: r.occurred_at,
    createdAt: r.created_at,
  };
}

export const playbookEvents = {
  async record(input: Omit<PlaybookEventRow, "id" | "createdAt">): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO memory_playbook_events
        (id, project_id, conversation_id, message_id, kind, payload_json, occurred_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id, input.projectId, input.conversationId, input.messageId, input.kind,
        input.payloadJson, input.occurredAt, now(),
      ],
    );
    return id;
  },

  async listByProject(projectId: string, limit = 200): Promise<PlaybookEventRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM memory_playbook_events WHERE project_id = $1 ORDER BY occurred_at DESC LIMIT $2",
      [projectId, limit],
    );
    return rows.map(rowToPlaybookEvent);
  },

  async listByConversation(conversationId: string, limit = 100): Promise<PlaybookEventRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM memory_playbook_events WHERE conversation_id = $1 ORDER BY occurred_at DESC LIMIT $2",
      [conversationId, limit],
    );
    return rows.map(rowToPlaybookEvent);
  },

  async listByProjectSince(projectId: string, sinceIso: string, limit = 200): Promise<PlaybookEventRow[]> {
    // Reflector 周期消费：拉取 sinceIso 之后的事件
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM memory_playbook_events WHERE project_id = $1 AND occurred_at >= $2 ORDER BY occurred_at ASC LIMIT $3",
      [projectId, sinceIso, limit],
    );
    return rows.map(rowToPlaybookEvent);
  },
};