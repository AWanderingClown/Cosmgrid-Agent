import { searchAcrossProjectsHybrid, type ProjectMemorySearchHit, type SearchAcrossProjectsHybridOptions } from "./retrieval";

export interface ProjectMemoryRetrievalEvalCase {
  id: string;
  query: string;
  expectedMemoryIds: string[];
  options?: SearchAcrossProjectsHybridOptions;
}

export interface ProjectMemoryRetrievalEvalCaseResult {
  id: string;
  query: string;
  expectedMemoryIds: string[];
  returnedMemoryIds: string[];
  top1Hit: boolean;
  topKHit: boolean;
}

export interface ProjectMemoryRetrievalEvalReport {
  total: number;
  top1Accuracy: number;
  topKRecall: number;
  misses: ProjectMemoryRetrievalEvalCaseResult[];
  results: ProjectMemoryRetrievalEvalCaseResult[];
}

export type ProjectMemorySearchFn = (
  query: string,
  options?: SearchAcrossProjectsHybridOptions,
) => Promise<ProjectMemorySearchHit[]>;

export async function evaluateProjectMemoryRetrieval(
  cases: ProjectMemoryRetrievalEvalCase[],
  search: ProjectMemorySearchFn = searchAcrossProjectsHybrid,
): Promise<ProjectMemoryRetrievalEvalReport> {
  const results: ProjectMemoryRetrievalEvalCaseResult[] = [];

  for (const testCase of cases) {
    const hits = await search(testCase.query, testCase.options);
    const returnedMemoryIds = hits.map((hit) => hit.id);
    const expected = new Set(testCase.expectedMemoryIds);
    const top1Hit = returnedMemoryIds[0] !== undefined && expected.has(returnedMemoryIds[0]);
    const topKHit = returnedMemoryIds.some((id) => expected.has(id));
    results.push({
      id: testCase.id,
      query: testCase.query,
      expectedMemoryIds: testCase.expectedMemoryIds,
      returnedMemoryIds,
      top1Hit,
      topKHit,
    });
  }

  const total = results.length;
  const top1Hits = results.filter((result) => result.top1Hit).length;
  const topKHits = results.filter((result) => result.topKHit).length;
  return {
    total,
    top1Accuracy: total === 0 ? 0 : top1Hits / total,
    topKRecall: total === 0 ? 0 : topKHits / total,
    misses: results.filter((result) => !result.topKHit),
    results,
  };
}
