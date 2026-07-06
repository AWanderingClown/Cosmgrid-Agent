export interface ProjectMemoryRetrievalWeights {
  semantic: number;
  lexical: number;
  importance: number;
}

export interface ProjectMemoryRetrievalTuning {
  limit: number;
  perProjectLimit: number;
  minImportance: number;
  minScore: number;
  hotBackfillLimit: number;
  manualSyncLimit: number;
  lexicalFallbackBaseScore: number;
  lexicalSearchMultiplier: number;
  lexicalSearchMinLimit: number;
  weights: ProjectMemoryRetrievalWeights;
}

export const DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING: ProjectMemoryRetrievalTuning = {
  limit: 3,
  perProjectLimit: 1,
  minImportance: 60,
  minScore: 0.52,
  hotBackfillLimit: 50,
  manualSyncLimit: 200,
  lexicalFallbackBaseScore: 0.2,
  lexicalSearchMultiplier: 4,
  lexicalSearchMinLimit: 12,
  weights: {
    semantic: 0.65,
    lexical: 0.2,
    importance: 0.15,
  },
};

export function normalizeImportanceScore(importance: number): number {
  return Math.max(0, Math.min(1, importance / 100));
}

export function scoreProjectMemoryHit(input: {
  semanticScore: number;
  lexicalScore: number;
  importance: number;
  weights?: ProjectMemoryRetrievalWeights;
}): number {
  const weights = input.weights ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.weights;
  return input.semanticScore * weights.semantic
    + input.lexicalScore * weights.lexical
    + normalizeImportanceScore(input.importance) * weights.importance;
}

export function scoreLexicalFallbackHit(input: {
  lexicalScore: number;
  importance: number;
  tuning?: ProjectMemoryRetrievalTuning;
}): number {
  const tuning = input.tuning ?? DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING;
  return tuning.lexicalFallbackBaseScore + normalizeImportanceScore(input.importance) * tuning.weights.importance;
}
