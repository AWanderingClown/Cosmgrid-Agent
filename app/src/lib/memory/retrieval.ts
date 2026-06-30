import {
  projectMemories,
  projectMemoryVectors,
  type ProjectMemory,
} from "@/lib/db";
import { buildCrossProjectMemoryPreamble } from "@/lib/llm/context-preamble";
import type { EmbeddingProvider } from "@/lib/llm/embedding";
import { cosineSimilarity } from "@/lib/llm/similarity";
import { getProjectMemoryEmbeddingProvider } from "./embedding-provider";

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

const DEFAULT_LIMIT = 3;
const DEFAULT_PER_PROJECT_LIMIT = 1;
const DEFAULT_MIN_IMPORTANCE = 60;
const DEFAULT_MIN_SCORE = 0.52;
const DEFAULT_BACKFILL_LIMIT = 50;

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function normalizeImportance(importance: number): number {
  return Math.max(0, Math.min(1, importance / 100));
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
  const limit = options.limit ?? DEFAULT_BACKFILL_LIMIT;
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

  const limit = options.limit ?? DEFAULT_LIMIT;
  const perProjectLimit = Math.max(1, options.perProjectLimit ?? DEFAULT_PER_PROJECT_LIMIT);
  const minImportance = Math.max(0, options.minImportance ?? DEFAULT_MIN_IMPORTANCE);
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const lexicalPromise = options.fallbackToLike === false
    ? Promise.resolve<ProjectMemory[]>([])
    : projectMemories.searchAcrossProjects(q, {
        excludeProjectId: options.excludeProjectId,
        limit: Math.max(limit * 4, 12),
        perProjectLimit: Math.max(2, perProjectLimit),
        minImportance,
      });

  try {
    const provider = await getProjectMemoryEmbeddingProvider();
    if (provider.supportsHotBackfill) {
      await backfillProjectMemoryVectors({
        limit: options.backfillLimit ?? DEFAULT_BACKFILL_LIMIT,
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
        const importanceScore = normalizeImportance(row.importance);
        return {
          ...row,
          providerName: row.providerName,
          semanticScore,
          lexicalScore,
          score: semanticScore * 0.65 + lexicalScore * 0.2 + importanceScore * 0.15,
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
      score: 0.2 + normalizeImportance(hit.importance) * 0.15,
    }));
  } catch {
    const lexicalHits = await lexicalPromise;
    return lexicalHits.slice(0, limit).map((hit, index) => ({
      ...hit,
      providerName: "lexical-fallback",
      semanticScore: 0,
      lexicalScore: 1 - index / Math.max(lexicalHits.length, 1),
      score: 0.2 + normalizeImportance(hit.importance) * 0.15,
    }));
  }
}

export async function retrieveCrossProjectMemoriesForPrompt(
  projectId: string,
  userText: string,
  options: Omit<SearchAcrossProjectsHybridOptions, "excludeProjectId"> = {},
): Promise<{ hits: ProjectMemorySearchHit[]; preamble: string | null }> {
  const hits = await searchAcrossProjectsHybrid(userText, {
    excludeProjectId: projectId,
    limit: options.limit ?? DEFAULT_LIMIT,
    perProjectLimit: options.perProjectLimit ?? DEFAULT_PER_PROJECT_LIMIT,
    minImportance: options.minImportance ?? DEFAULT_MIN_IMPORTANCE,
    minScore: options.minScore ?? DEFAULT_MIN_SCORE,
    fallbackToLike: options.fallbackToLike,
    backfillLimit: options.backfillLimit,
  });
  return {
    hits,
    preamble: buildCrossProjectMemoryPreamble(hits),
  };
}
