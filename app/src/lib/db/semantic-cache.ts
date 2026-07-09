import { getDb } from "./connection";
import { newId, now } from "./utils";

// ============ semanticCache CRUD（v0.9 阶段7：语义缓存） ============

export interface SemanticCacheRow {
  id: string;
  queryText: string;
  queryEmbedding: number[];
  responseText: string;
  modelId: string;
  taskType: string;
  /** embedding provider 名（如 'keyword-hash-v2'）——lookup 时不匹配直接跳过 */
  providerName: string;
  hitCount: number;
  lastHitAt: string | null;
  expiresAt: string;
  createdAt: string;
}

function mapCacheRow(r: any): SemanticCacheRow {
  return {
    id: r.id,
    queryText: r.query_text,
    queryEmbedding: JSON.parse(r.query_embedding),
    responseText: r.response_text,
    modelId: r.model_id,
    taskType: r.task_type,
    // 老库可能没 provider_name 列（DEFAULT 'keyword-hash'）— 安全降级
    providerName: r.provider_name ?? "keyword-hash",
    hitCount: r.hit_count,
    lastHitAt: r.last_hit_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

export const semanticCache = {
  /** 写入一条缓存 */
  async create(input: {
    queryText: string;
    queryEmbedding: number[];
    responseText: string;
    modelId: string;
    taskType: string;
    expiresAt: string;
    /** embedding provider 名（写入时按当前 provider.name 取） */
    providerName?: string;
  }): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT INTO semantic_cache
        (id, query_text, query_embedding, response_text, model_id, task_type,
         provider_name, hit_count, last_hit_at, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,NULL,$8,$9)`,
      [
        newId(), input.queryText, JSON.stringify(input.queryEmbedding), input.responseText,
        input.modelId, input.taskType, input.providerName ?? "keyword-hash",
        input.expiresAt, now(),
      ]
    );
  },

  /** 列出所有未过期缓存（检索时纯 JS 余弦扫描） */
  async listValid(): Promise<SemanticCacheRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM semantic_cache WHERE expires_at > $1",
      [now()]
    );
    return rows.map(mapCacheRow);
  },

  /** 命中后累加命中次数 + 更新 last_hit_at */
  async recordHit(id: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE semantic_cache SET hit_count = hit_count + 1, last_hit_at = $1 WHERE id = $2",
      [now(), id]
    );
  },

  /** 清理过期缓存，返回删除条数 */
  async deleteExpired(): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM semantic_cache WHERE expires_at <= $1", [now()]);
  },

  /** 清空全部缓存（用户在用量页手动重置，或旧脏缓存一键清掉） */
  async deleteAll(): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM semantic_cache");
  },

  /** 缓存统计：条目数 + 累计命中次数（StatsPage 用） */
  async stats(): Promise<{ entries: number; totalHits: number }> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT COUNT(*) AS entries, COALESCE(SUM(hit_count), 0) AS total_hits FROM semantic_cache"
    );
    const r = rows[0] ?? { entries: 0, total_hits: 0 };
    return { entries: Number(r.entries) || 0, totalHits: Number(r.total_hits) || 0 };
  },
};
