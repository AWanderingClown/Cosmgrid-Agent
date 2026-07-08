// v0.9.1 — 上下文压缩的摘要落库
//
// 与 history-summarizer.ts 的关系：
//   - history-summarizer 负责"调 LLM 拿到结构化 HistorySummary"
//   - 本文件负责"把 HistorySummary 持久化到 conversation_summaries"
//
// 模式（沿用 db/conversations.ts 的 DAO 约定）：
//   - ConversationSummaryRow / ConversationSummary 接口分离（DB 行 vs 业务对象）
//   - 单一 mapRow 出口；加字段时只改这里，杜绝 SELECT mapper 漏字段
//   - create / listRecentByConversation 暴露给上层调用
//
// 读缓存命中（同一批 dropped 复用上次摘要）——TODO：本轮只做"摘要后写库"，
// 读路径等下一轮 fingerprint 算法决策后再补；现在 read 接口也写出来，调用方可以预热。

import { getDb } from "./connection";
import { newId, now } from "./utils";

export interface ConversationSummaryRow {
  id: string;
  conversation_id: string;
  summary: string;
  key_decisions_json: string | null;
  facts_json: string | null;
  open_threads_json: string | null;
  model_id: string | null;
  token_count: number | null;
  created_at: string;
}

export interface ConversationSummary {
  id: string;
  conversationId: string;
  summary: string;
  keyDecisions: string[];
  factsEstablished: string[];
  openThreads: string[];
  modelId: string | null;
  tokenCount: number | null;
  createdAt: string;
}

function mapRow(r: ConversationSummaryRow): ConversationSummary {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    summary: r.summary,
    keyDecisions: parseStringArray(r.key_decisions_json),
    factsEstablished: parseStringArray(r.facts_json),
    openThreads: parseStringArray(r.open_threads_json),
    modelId: r.model_id,
    tokenCount: r.token_count,
    createdAt: r.created_at,
  };
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export interface CreateConversationSummaryInput {
  conversationId: string;
  summary: string;
  keyDecisions?: string[];
  factsEstablished?: string[];
  openThreads?: string[];
  modelId?: string | null;
  tokenCount?: number | null;
}

export async function create(input: CreateConversationSummaryInput): Promise<ConversationSummary> {
  const db = await getDb();
  const id = newId();
  const createdAt = now();
  await db.execute(
    `INSERT INTO conversation_summaries
       (id, conversation_id, summary, key_decisions_json, facts_json, open_threads_json, model_id, token_count, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.conversationId,
      input.summary,
      JSON.stringify(input.keyDecisions ?? []),
      JSON.stringify(input.factsEstablished ?? []),
      JSON.stringify(input.openThreads ?? []),
      input.modelId ?? null,
      input.tokenCount ?? null,
      createdAt,
    ],
  );
  return {
    id,
    conversationId: input.conversationId,
    summary: input.summary,
    keyDecisions: input.keyDecisions ?? [],
    factsEstablished: input.factsEstablished ?? [],
    openThreads: input.openThreads ?? [],
    modelId: input.modelId ?? null,
    tokenCount: input.tokenCount ?? null,
    createdAt,
  };
}

/**
 * 列出某对话最近的摘要（按 created_at DESC）。
 * TODO：本轮未接入"读命中"逻辑（等 fingerprint 算法决策）；本接口为下一轮预热。
 */
export async function listRecentByConversation(
  conversationId: string,
  limit = 10,
): Promise<ConversationSummary[]> {
  const db = await getDb();
  const rows = await db.select<ConversationSummaryRow[]>(
    `SELECT id, conversation_id, summary, key_decisions_json, facts_json, open_threads_json,
            model_id, token_count, created_at
       FROM conversation_summaries
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [conversationId, limit],
  );
  return rows.map(mapRow);
}

export const conversationSummaries = {
  create,
  listRecentByConversation,
};