import { describe, it, expect } from "vitest";
import {
  buildRolePerformanceScoresFromUsageRows,
  pickBestModelWithPerformance,
  pickBestModelWithRolePerformance,
  type PerformanceScores,
} from "../model-performance-scoring";
import type { ScorableModel } from "../model-capabilities";
import type { UsageEventRow } from "../../db";

// 用 M3（unknown 档，静态 main_chat=72）和 agnes（balanced，静态 90）构造
// 静态分下 agnes 赢；真表现分下可以反过来——验证真表现覆盖静态
const mk = (id: string, name: string): ScorableModel => ({
  id,
  name,
  capabilityScore: null, // 强制走 inferModelCapabilities（名字查表）
  workRoles: "[]",
});

const models = [mk("m3", "MiniMax-M3"), mk("agnes", "agnes-2.0-flash")];

describe("pickBestModelWithPerformance", () => {
  // 三层优先级：真表现 > 用户基线 > 名字查表
  // M3 用户基线 main_chat=42（70*0.6，不擅长）；agnes 用户基线=36（60*0.6，不确定）
  // 没真表现时 M3(42) > agnes(36) → M3 赢（用户基线 M3 比 agnes 强，符合用户判断）
  it("没传真表现分 → fallback 用户基线（M3 70 > agnes 60，M3 赢）", () => {
    const best = pickBestModelWithPerformance("main_chat", models);
    expect(best?.id).toBe("m3");
  });

  it("传了真表现分 → 真表现优先（覆盖用户基线）", () => {
    const scores: PerformanceScores = new Map([
      ["m3", 30],
      ["agnes", 88],
    ]);
    const best = pickBestModelWithPerformance("main_chat", models, scores);
    expect(best?.id).toBe("agnes"); // 真表现 agnes 88 > M3 30
  });

  it("真表现分里只有部分模型有记录 → 有记录的用真表现，没的用基线", () => {
    const scores: PerformanceScores = new Map([["agnes", 88]]);
    const best = pickBestModelWithPerformance("main_chat", models, scores);
    expect(best?.id).toBe("agnes"); // agnes 真表现 88 > M3 基线 42
  });

  it("真表现分空 Map → fallback 用户基线", () => {
    const best = pickBestModelWithPerformance("main_chat", models, new Map());
    expect(best?.id).toBe("m3");
  });

  it("空候选返回 null", () => {
    expect(pickBestModelWithPerformance("main_chat", [])).toBeNull();
  });
});

function usage(over: Partial<UsageEventRow>): UsageEventRow {
  return {
    id: "u",
    providerId: null,
    apiCredentialId: null,
    modelId: "m",
    projectId: null,
    conversationId: null,
    role: "hard",
    roleKind: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheHitTokens: 0,
    cost: 0,
    pricingKnown: true,
    priceVersion: null,
    priceSource: null,
    priceCatalogId: null,
    success: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

describe("role-aware performance scores", () => {
  it("只按 roleKind 聚合，不把 leader 表现错用到 frontend", () => {
    const scores = buildRolePerformanceScoresFromUsageRows([
      usage({ roleKind: "leader", modelId: "m3", success: true, cost: 0.01 }),
      usage({ roleKind: "frontend", modelId: "agnes", success: true, cost: 0.01 }),
    ]);

    expect(scores.get("leader")?.has("m3")).toBe(true);
    expect(scores.get("frontend")?.has("m3")).toBe(false);
  });

  it("角色表现分只是有限加成，不让明显不适合该角色的模型乱抢", () => {
    const frontendModels = [
      mk("fast", "claude-haiku-4-5"),
      mk("coder", "claude-sonnet-4-6"),
    ];
    const roleScores = new Map<string, PerformanceScores>([
      ["frontend", new Map([
        ["fast", 100],
        ["coder", 0],
      ])],
    ]);

    const best = pickBestModelWithRolePerformance("frontend", "frontend", frontendModels, roleScores);
    expect(best?.id).toBe("coder");
  });

  it("价格未知不会被当成免费优势", () => {
    const scores = buildRolePerformanceScoresFromUsageRows([
      usage({ roleKind: "tester", modelId: "unknown-cost", success: true, pricingKnown: false, cost: 0 }),
      usage({ roleKind: "tester", modelId: "known-cost", success: true, pricingKnown: true, cost: 0.01 }),
    ]);

    expect(scores.get("tester")?.get("unknown-cost")).toBe(88);
    expect(scores.get("tester")?.get("known-cost")).toBe(75);
  });
});
