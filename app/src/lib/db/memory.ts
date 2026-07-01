import { getDb } from "./connection";
import { newId, now } from "./utils";

// ============ projectMemories CRUD（v0.6 / 5.6 RAG） ============

export type MemoryKind = "decision" | "lesson" | "context" | "preference" | "other";

/**
 * 把 memory kind 翻译成当前语言的 label（v0.7 i18n 化：原本是硬编码中文常量）
 * UI 层调用：memoryKindLabel(m.kind, t) → "决策" / "Decision" 等
 */
export function memoryKindLabel(kind: string, t: (k: string) => string): string {
  const known: MemoryKind[] = ["decision", "lesson", "context", "preference", "other"];
  if ((known as string[]).includes(kind)) {
    return t(`memoryKind.${kind}`);
  }
  return kind;
}

export interface ProjectMemory {
  id: string;
  projectId: string;
  projectName?: string | null;
  kind: string;
  title: string;
  content: string;
  importance: number;
  tags: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectMemoryRow {
  id: string;
  project_id: string;
  project_name?: string | null;
  kind: string;
  title: string;
  content: string;
  importance: number;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProjectMemory(r: ProjectMemoryRow): ProjectMemory {
  return {
    id: r.id,
    projectId: r.project_id,
    projectName: r.project_name ?? null,
    kind: r.kind,
    title: r.title,
    content: r.content,
    importance: r.importance,
    tags: r.tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateProjectMemoryInput {
  projectId: string;
  kind: string;
  title: string;
  content: string;
  importance?: number;
  tags?: string | null;
}

export interface SearchProjectMemoriesOptions {
  limit?: number;
  excludeProjectId?: string;
  minImportance?: number;
  perProjectLimit?: number;
}

export const projectMemories = {
  async listAll(options: { excludeProjectId?: string; minImportance?: number; limit?: number } = {}): Promise<ProjectMemory[]> {
    const db = await getDb();
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (options.excludeProjectId) {
      params.push(options.excludeProjectId);
      clauses.push(`project_id != $${params.length}`);
    }
    if (options.minImportance !== undefined) {
      params.push(Math.max(0, options.minImportance));
      clauses.push(`importance >= $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = options.limit ? `LIMIT $${params.length + 1}` : "";
    if (options.limit) params.push(options.limit);
    const rows = await db.select<ProjectMemoryRow[]>(
      `SELECT * FROM project_memories ${where} ORDER BY importance DESC, updated_at DESC ${limitClause}`,
      params,
    );
    return rows.map(rowToProjectMemory);
  },

  async listByProject(projectId: string): Promise<ProjectMemory[]> {
    const db = await getDb();
    const rows = await db.select<ProjectMemoryRow[]>(
      "SELECT * FROM project_memories WHERE project_id = $1 ORDER BY importance DESC, created_at DESC",
      [projectId],
    );
    return rows.map(rowToProjectMemory);
  },

  async getById(id: string): Promise<ProjectMemory | null> {
    const db = await getDb();
    const rows = await db.select<ProjectMemoryRow[]>(
      "SELECT * FROM project_memories WHERE id = $1",
      [id],
    );
    return rows[0] ? rowToProjectMemory(rows[0]) : null;
  },

  async create(input: CreateProjectMemoryInput): Promise<ProjectMemory> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO project_memories (id, project_id, kind, title, content, importance, tags, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        input.projectId,
        input.kind,
        input.title,
        input.content,
        input.importance ?? 50,
        input.tags ?? null,
        ts,
        ts,
      ],
    );
    return (await projectMemories.getById(id))!;
  },

  async update(
    id: string,
    input: Partial<CreateProjectMemoryInput>,
  ): Promise<ProjectMemory> {
    const db = await getDb();
    const ts = now();
    const sets: string[] = ["updated_at = $1"];
    const vals: unknown[] = [ts];
    let i = 2;
    if (input.kind !== undefined) {
      sets.push(`kind = $${i++}`);
      vals.push(input.kind);
    }
    if (input.title !== undefined) {
      sets.push(`title = $${i++}`);
      vals.push(input.title);
    }
    if (input.content !== undefined) {
      sets.push(`content = $${i++}`);
      vals.push(input.content);
    }
    if (input.importance !== undefined) {
      sets.push(`importance = $${i++}`);
      vals.push(input.importance);
    }
    if (input.tags !== undefined) {
      sets.push(`tags = $${i++}`);
      vals.push(input.tags);
    }
    vals.push(id);
    await db.execute(
      `UPDATE project_memories SET ${sets.join(", ")} WHERE id = $${i}`,
      vals,
    );
    return (await projectMemories.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM project_memories WHERE id = $1", [id]);
  },

  /**
   * 跨项目检索：根据关键词在所有项目的记忆里做 LIKE 匹配。
   * 减负实现：不做 Embedding、不接外部 API，纯关键词 + importance 加权排序。
   * 适合「5 个项目 / 上千条记忆」以内的小白使用规模；规模化时再换向量检索。
   */
  async searchAcrossProjects(
    query: string,
    options: SearchProjectMemoriesOptions = {},
  ): Promise<ProjectMemory[]> {
    const limit = options.limit ?? 10;
    const perProjectLimit = Math.max(1, options.perProjectLimit ?? 1);
    const minImportance = Math.max(0, options.minImportance ?? 0);
    const db = await getDb();
    const q = query.trim();
    if (!q) return [];
    // 拆词 + 任何一词命中都行（OR），按 importance + 命中数排
    const tokens = Array.from(new Set(q
      .split(/[\s,，、]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 1)
      .slice(0, 8)));
    if (tokens.length === 0) return [];

    const likeConditions: string[] = [];
    const likeParams: unknown[] = [];
    tokens.forEach((tok, idx) => {
      const p = `$${idx + 1}`;
      likeConditions.push(`(title LIKE ${p} OR content LIKE ${p} OR tags LIKE ${p})`);
      likeParams.push(`%${tok}%`);
    });
    const excludeClause = options.excludeProjectId
      ? `AND project_id != $${likeParams.length + 1}`
      : "";
    if (options.excludeProjectId) likeParams.push(options.excludeProjectId);
    const importanceClause = minImportance > 0
      ? `AND importance >= $${likeParams.length + 1}`
      : "";
    if (minImportance > 0) likeParams.push(minImportance);

    const sql = `
      SELECT pm.*, p.name AS project_name,
        (${likeConditions.map((c) => `CASE WHEN ${c} THEN 1 ELSE 0 END`).join(" + ")}) AS hits
      FROM project_memories pm
      LEFT JOIN projects p ON p.id = pm.project_id
      WHERE (${likeConditions.join(" OR ")})
      ${excludeClause}
      ${importanceClause}
      ORDER BY (importance / 100.0 + hits * 0.1) DESC, created_at DESC
      LIMIT $${likeParams.length + 1}
    `;
    likeParams.push(Math.max(limit * perProjectLimit, limit));
    const rows = await db.select<ProjectMemoryRow[]>(sql, likeParams);
    const picked = new Map<string, number>();
    const filtered: ProjectMemory[] = [];
    for (const row of rows) {
      const count = picked.get(row.project_id) ?? 0;
      if (count >= perProjectLimit) continue;
      filtered.push(rowToProjectMemory(row));
      picked.set(row.project_id, count + 1);
      if (filtered.length >= limit) break;
    }
    return filtered;
  },
};

export interface ProjectMemoryVector {
  memoryId: string;
  projectId: string;
  providerName: string;
  dim: number;
  embedding: number[];
  sourceHash: string;
  sourceUpdatedAt: string;
  indexedAt: string;
}

interface ProjectMemoryVectorRow {
  memory_id: string;
  project_id: string;
  provider_name: string;
  dim: number;
  embedding_json: string;
  source_hash: string;
  source_updated_at: string;
  indexed_at: string;
}

export interface ProjectMemoryVectorSearchRow extends ProjectMemory {
  providerName: string;
  dim: number;
  embedding: number[];
  sourceHash: string;
  sourceUpdatedAt: string;
  indexedAt: string;
}

function rowToProjectMemoryVector(r: ProjectMemoryVectorRow): ProjectMemoryVector {
  return {
    memoryId: r.memory_id,
    projectId: r.project_id,
    providerName: r.provider_name,
    dim: r.dim,
    embedding: JSON.parse(r.embedding_json),
    sourceHash: r.source_hash,
    sourceUpdatedAt: r.source_updated_at,
    indexedAt: r.indexed_at,
  };
}

export const projectMemoryVectors = {
  async get(memoryId: string, providerName: string): Promise<ProjectMemoryVector | null> {
    const db = await getDb();
    const rows = await db.select<ProjectMemoryVectorRow[]>(
      "SELECT * FROM project_memory_vectors WHERE memory_id = $1 AND provider_name = $2 LIMIT 1",
      [memoryId, providerName],
    );
    return rows[0] ? rowToProjectMemoryVector(rows[0]) : null;
  },

  async listByProvider(providerName: string): Promise<ProjectMemoryVector[]> {
    const db = await getDb();
    const rows = await db.select<ProjectMemoryVectorRow[]>(
      "SELECT * FROM project_memory_vectors WHERE provider_name = $1",
      [providerName],
    );
    return rows.map(rowToProjectMemoryVector);
  },

  async upsert(input: {
    memoryId: string;
    projectId: string;
    providerName: string;
    dim: number;
    embedding: number[];
    sourceHash: string;
    sourceUpdatedAt: string;
  }): Promise<void> {
    const db = await getDb();
    const ts = now();
    await db.execute(
      `INSERT INTO project_memory_vectors
        (memory_id, project_id, provider_name, dim, embedding_json, source_hash, source_updated_at, indexed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(memory_id, provider_name)
       DO UPDATE SET
         project_id = excluded.project_id,
         dim = excluded.dim,
         embedding_json = excluded.embedding_json,
         source_hash = excluded.source_hash,
         source_updated_at = excluded.source_updated_at,
         indexed_at = excluded.indexed_at`,
      [
        input.memoryId,
        input.projectId,
        input.providerName,
        input.dim,
        JSON.stringify(input.embedding),
        input.sourceHash,
        input.sourceUpdatedAt,
        ts,
      ],
    );
  },

  async listSearchRows(options: {
    providerName: string;
    excludeProjectId?: string;
    minImportance?: number;
  }): Promise<ProjectMemoryVectorSearchRow[]> {
    const db = await getDb();
    const params: unknown[] = [options.providerName];
    const clauses = ["pmv.provider_name = $1"];
    if (options.excludeProjectId) {
      params.push(options.excludeProjectId);
      clauses.push(`pm.project_id != $${params.length}`);
    }
    if (options.minImportance !== undefined) {
      params.push(Math.max(0, options.minImportance));
      clauses.push(`pm.importance >= $${params.length}`);
    }
    const rows = await db.select<Array<ProjectMemoryVectorRow & ProjectMemoryRow>>(
      `SELECT
          pm.id,
          pm.project_id,
          p.name AS project_name,
          pm.kind,
          pm.title,
          pm.content,
          pm.importance,
          pm.tags,
          pm.created_at,
          pm.updated_at,
          pmv.provider_name,
          pmv.dim,
          pmv.embedding_json,
          pmv.source_hash,
          pmv.source_updated_at,
          pmv.indexed_at,
          pmv.memory_id
       FROM project_memory_vectors pmv
       INNER JOIN project_memories pm ON pm.id = pmv.memory_id
       LEFT JOIN projects p ON p.id = pm.project_id
       WHERE ${clauses.join(" AND ")}`,
      params,
    );
    return rows.map((r) => ({
      ...rowToProjectMemory(r),
      providerName: r.provider_name,
      dim: r.dim,
      embedding: JSON.parse(r.embedding_json),
      sourceHash: r.source_hash,
      sourceUpdatedAt: r.source_updated_at,
      indexedAt: r.indexed_at,
    }));
  },
};
