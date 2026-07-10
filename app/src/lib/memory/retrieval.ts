import {
  projectMemories,
  projectMemoryVectors,
  type ProjectMemory,
} from "@/lib/db";
import { buildCrossProjectMemoryPreamble } from "@/lib/llm/prompts/context-preamble";
import type { EmbeddingProvider } from "@/lib/llm/embedding";
import { cosineSimilarity } from "@/lib/llm/similarity";
import { getProjectMemoryEmbeddingProvider } from "./embedding-provider";
import {
  DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING,
  scoreLexicalFallbackHit,
  scoreProjectMemoryHit,
} from "./retrieval-tuning";

export interface ProjectMemorySearchHit extends ProjectMemory {
  score: number;
  semanticScore: number;
  lexicalScore: number;
  providerName: string;
}

export interface SearchAcrossProjectsHybridOptions {
  excludeProjectId?: string;
  limit?: number;
  perProjectLimit?: number;
  minImportance?: number;
  minScore?: number;
  fallbackToLike?: boolean;
  backfillLimit?: number;
}

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function buildProjectMemoryEmbeddingSource(memory: Pick<ProjectMemory, "kind" | "title" | "content" | "tags">): string {
  const tags = memory.tags?.trim() ? `tags: ${memory.tags.trim()}` : "";
  return [
    `title: ${memory.title.trim()}`,
    `title: ${memory.title.trim()}`,
    `kind: ${memory.kind}`,
    tags,
    `content: ${memory.content.trim()}`,
  ].filter(Boolean).join("\n");
}

export function buildProjectMemorySourceHash(memory: Pick<ProjectMemory, "kind" | "title" | "content" | "tags">): string {
  return hashText(buildProjectMemoryEmbeddingSource(memory));
}

export async function syncProjectMemoryVector(memory: ProjectMemory, providerArg?: EmbeddingProvider): Promise<void> {
  const provider = providerArg ?? await getProjectMemoryEmbeddingProvider();
  const sourceHash = buildProjectMemorySourceHash(memory);
  const existing = await projectMemoryVectors.get(memory.id, provider.name);
  if (existing?.sourceHash === sourceHash && existing.sourceUpdatedAt === memory.updatedAt) return;
  const source = buildProjectMemoryEmbeddingSource(memory);
  const embedding = await provider.embed(source);
  await projectMemoryVectors.upsert({
    memoryId: memory.id,
    projectId: memory.projectId,
    providerName: provider.name,
    dim: embedding.length,
    embedding,
    sourceHash,
    sourceUpdatedAt: memory.updatedAt,
  });
}

export async function backfillProjectMemoryVectors(options: {
  limit?: number;
  excludeProjectId?: string;
  minImportance?: number;
  allowRemote?: boolean;
} = {}): Promise<number> {
  const limit = options.limit ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.hotBackfillLimit;
  const provider = await getProjectMemoryEmbeddingProvider();
  if (!provider.supportsHotBackfill && !options.allowRemote) return 0;
  const [memories, vectors] = await Promise.all([
    projectMemories.listAll({
      excludeProjectId: options.excludeProjectId,
      minImportance: options.minImportance,
    }),
    projectMemoryVectors.listByProvider(provider.name),
  ]);
  const vectorMap = new Map(vectors.map((v) => [v.memoryId, v]));
  let synced = 0;
  for (const memory of memories) {
    if (synced >= limit) break;
    const nextHash = buildProjectMemorySourceHash(memory);
    const existing = vectorMap.get(memory.id);
    if (existing?.sourceHash === nextHash && existing.sourceUpdatedAt === memory.updatedAt) continue;
    await syncProjectMemoryVector(memory, provider);
    synced += 1;
  }
  return synced;
}

function applyPerProjectLimit(
  rows: ProjectMemorySearchHit[],
  perProjectLimit: number,
  limit: number,
): ProjectMemorySearchHit[] {
  const picked = new Map<string, number>();
  const out: ProjectMemorySearchHit[] = [];
  for (const row of rows) {
    const count = picked.get(row.projectId) ?? 0;
    if (count >= perProjectLimit) continue;
    out.push(row);
    picked.set(row.projectId, count + 1);
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchAcrossProjectsHybrid(
  query: string,
  options: SearchAcrossProjectsHybridOptions = {},
): Promise<ProjectMemorySearchHit[]> {
  const q = query.trim();
  if (!q) return [];

  const limit = options.limit ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.limit;
  const perProjectLimit = Math.max(1, options.perProjectLimit ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.perProjectLimit);
  const minImportance = Math.max(0, options.minImportance ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.minImportance);
  const minScore = options.minScore ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.minScore;
  const lexicalPromise = options.fallbackToLike === false
    ? Promise.resolve<ProjectMemory[]>([])
    : projectMemories.searchAcrossProjects(q, {
        excludeProjectId: options.excludeProjectId,
        limit: Math.max(
          limit * DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.lexicalSearchMultiplier,
          DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.lexicalSearchMinLimit,
        ),
        perProjectLimit: Math.max(2, perProjectLimit),
        minImportance,
      });

  try {
    const provider = await getProjectMemoryEmbeddingProvider();
    if (provider.supportsHotBackfill) {
      await backfillProjectMemoryVectors({
        limit: options.backfillLimit ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.hotBackfillLimit,
        excludeProjectId: options.excludeProjectId,
        minImportance,
      });
    }

    const [queryEmbedding, rows, lexicalHits] = await Promise.all([
      provider.embed(q),
      projectMemoryVectors.listSearchRows({
        providerName: provider.name,
        excludeProjectId: options.excludeProjectId,
        minImportance,
      }),
      lexicalPromise,
    ]);
    const lexicalRank = new Map<string, number>();
    lexicalHits.forEach((hit, index) => {
      lexicalRank.set(hit.id, 1 - index / Math.max(lexicalHits.length, 1));
    });

    const scored = rows
      .map<ProjectMemorySearchHit>((row) => {
        const semanticScore = row.embedding.length === queryEmbedding.length
          ? cosineSimilarity(queryEmbedding, row.embedding)
          : 0;
        const lexicalScore = lexicalRank.get(row.id) ?? 0;
        return {
          ...row,
          providerName: row.providerName,
          semanticScore,
          lexicalScore,
          score: scoreProjectMemoryHit({
            semanticScore,
            lexicalScore,
            importance: row.importance,
          }),
        };
      })
      .filter((row) => row.score >= minScore || row.lexicalScore > 0)
      .sort((a, b) => b.score - a.score || b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt));

    const filtered = applyPerProjectLimit(scored, perProjectLimit, limit);
    if (filtered.length > 0) return filtered;
    return lexicalHits.slice(0, limit).map((hit, index) => ({
      ...hit,
      providerName: "lexical-fallback",
      semanticScore: 0,
      lexicalScore: 1 - index / Math.max(lexicalHits.length, 1),
      score: scoreLexicalFallbackHit({
        lexicalScore: 1 - index / Math.max(lexicalHits.length, 1),
        importance: hit.importance,
      }),
    }));
  } catch {
    const lexicalHits = await lexicalPromise;
    return lexicalHits.slice(0, limit).map((hit, index) => ({
      ...hit,
      providerName: "lexical-fallback",
      semanticScore: 0,
      lexicalScore: 1 - index / Math.max(lexicalHits.length, 1),
      score: scoreLexicalFallbackHit({
        lexicalScore: 1 - index / Math.max(lexicalHits.length, 1),
        importance: hit.importance,
      }),
    }));
  }
}

/**
 * 同项目记忆检索：原来 listByProject 纯按 importance/创建时间排序，跟这轮用户问的是什么无关——
 * 跨项目那条路早就按相关性检索了，同项目反而没做，本末倒置。这里把"跟这句话相关的记忆"
 * （关键词 LIKE 命中）排到前面，剩余名额再用原有的 importance/时间排序补齐，
 * 不丢"长期重要但这轮没关键词命中"的记忆。
 */
export async function retrieveProjectMemoriesForPrompt(
  projectId: string,
  userText: string,
  options: { limit?: number } = {},
): Promise<ProjectMemory[]> {
  const limit = options.limit ?? 6;
  const [relevant, all] = await Promise.all([
    projectMemories.searchWithinProject(projectId, userText, { limit }),
    projectMemories.listByProject(projectId),
  ]);
  const seen = new Set(relevant.map((m) => m.id));
  const merged = [...relevant];
  for (const m of all) {
    if (merged.length >= limit) break;
    if (seen.has(m.id)) continue;
    merged.push(m);
  }
  return merged.slice(0, limit);
}

export async function retrieveCrossProjectMemoriesForPrompt(
  projectId: string,
  userText: string,
  options: Omit<SearchAcrossProjectsHybridOptions, "excludeProjectId"> = {},
): Promise<{ hits: ProjectMemorySearchHit[]; preamble: string | null }> {
  const hits = await searchAcrossProjectsHybrid(userText, {
    excludeProjectId: projectId,
    limit: options.limit ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.limit,
    perProjectLimit: options.perProjectLimit ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.perProjectLimit,
    minImportance: options.minImportance ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.minImportance,
    minScore: options.minScore ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.minScore,
    fallbackToLike: options.fallbackToLike,
    backfillLimit: options.backfillLimit,
  });
  return {
    hits,
    preamble: buildCrossProjectMemoryPreamble(hits),
  };
}
