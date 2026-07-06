import { describe, expect, it } from "vitest";
import { evaluateProjectMemoryRetrieval } from "../retrieval-eval";
import {
  DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING,
  scoreLexicalFallbackHit,
  scoreProjectMemoryHit,
} from "../retrieval-tuning";
import type { ProjectMemorySearchHit } from "../retrieval";

function hit(id: string): ProjectMemorySearchHit {
  return {
    id,
    projectId: "p",
    projectName: "Project",
    kind: "lesson",
    title: id,
    content: id,
    importance: 80,
    tags: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    score: 1,
    semanticScore: 1,
    lexicalScore: 0,
    providerName: "keyword-hash-v2",
  };
}

describe("project memory retrieval tuning", () => {
  it("用统一权重计算混合检索分", () => {
    const score = scoreProjectMemoryHit({
      semanticScore: 0.8,
      lexicalScore: 0.5,
      importance: 90,
    });

    expect(score).toBeCloseTo(0.8 * 0.65 + 0.5 * 0.2 + 0.9 * 0.15);
    expect(DEFAULT_PROJECT_MEMORY_RETRIEVAL_TUNING.minScore).toBe(0.52);
  });

  it("关键词兜底分沿用统一重要性权重", () => {
    expect(scoreLexicalFallbackHit({ lexicalScore: 1, importance: 80 })).toBeCloseTo(0.2 + 0.8 * 0.15);
  });
});

describe("project memory retrieval eval", () => {
  it("产出 top1 命中率、topK 召回率和漏召回列表", async () => {
    const report = await evaluateProjectMemoryRetrieval([
      { id: "case-1", query: "q1", expectedMemoryIds: ["m1"] },
      { id: "case-2", query: "q2", expectedMemoryIds: ["m4"] },
    ], async (query) => {
      if (query === "q1") return [hit("m1"), hit("m2")];
      return [hit("m3"), hit("m4")];
    });

    expect(report.total).toBe(2);
    expect(report.top1Accuracy).toBe(0.5);
    expect(report.topKRecall).toBe(1);
    expect(report.misses).toHaveLength(0);
  });

  it("空样例返回 0 指标，不报错", async () => {
    const report = await evaluateProjectMemoryRetrieval([]);
    expect(report.total).toBe(0);
    expect(report.top1Accuracy).toBe(0);
    expect(report.topKRecall).toBe(0);
  });
});
