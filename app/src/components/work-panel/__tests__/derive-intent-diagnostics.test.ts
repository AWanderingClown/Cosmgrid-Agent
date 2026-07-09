import { describe, expect, it } from "vitest";
import type { TurnIntentDecision } from "@/lib/workflow/types";
import type { SemanticIntentRoute, IntentRouteCandidate } from "@/lib/workflow/semantic-intent-router";
import type { IntentDiagnosticsEntry } from "@/lib/workflow/intent-diagnostics-buffer";
import {
  deriveIntentDiagnosticsRow,
  deriveIntentDiagnosticsRows,
  formatConfidence,
  inferIntentLayer,
} from "../derive-intent-diagnostics";

function candidate(overrides: Partial<IntentRouteCandidate>): IntentRouteCandidate {
  return {
    action: "answer_only",
    score: 0.7,
    margin: 0.1,
    matchedExample: {
      id: "ex-1",
      action: "answer_only",
      text: "解释一下这是什么意思",
      explanation: "普通解释性问题",
      source: "builtin",
      weight: 1,
      enabled: true,
    },
    ...overrides,
  };
}

function route(overrides: Partial<SemanticIntentRoute>): SemanticIntentRoute {
  return {
    candidates: [],
    top: null,
    confidence: 0,
    noMatch: true,
    ...overrides,
  };
}

function decision(overrides: Partial<TurnIntentDecision>): TurnIntentDecision {
  return {
    action: "answer_only",
    targetRunId: null,
    confidence: 0.9,
    reason: "测试原因",
    evidenceTurnIds: [],
    ...overrides,
  };
}

function entry(overrides: Partial<IntentDiagnosticsEntry>): IntentDiagnosticsEntry {
  return {
    id: "entry-1",
    capturedAt: "2026-07-09T10:00:00.000Z",
    userTextExcerpt: "帮我看看这个方案",
    decision: decision({}),
    route: route({}),
    ...overrides,
  };
}

describe("inferIntentLayer", () => {
  it("classifies cancel_run / pause_run as L0 hard rule", () => {
    expect(inferIntentLayer(entry({
      decision: decision({ action: "cancel_run", confidence: 0.92 }),
      route: route({ noMatch: true, top: null }),
    }))).toBe("L0-rule");

    expect(inferIntentLayer(entry({
      decision: decision({ action: "pause_run", confidence: 0.9 }),
      route: route({ noMatch: true, top: null }),
    }))).toBe("L0-rule");
  });

  it("classifies semantic route top matching decision with confidence ≥ 0.64 as L1", () => {
    expect(inferIntentLayer(entry({
      decision: decision({ action: "approve_node" }),
      route: route({
        top: candidate({ action: "execute", score: 0.7 }),
        confidence: 0.7,
        noMatch: false,
      }),
    }))).toBe("L1-semantic");
  });

  it("classifies route noMatch or low-confidence as L2 judge", () => {
    expect(inferIntentLayer(entry({
      decision: decision({ action: "approve_node" }),
      route: route({ noMatch: true, top: null }),
    }))).toBe("L2-judge");

    expect(inferIntentLayer(entry({
      decision: decision({ action: "approve_node" }),
      route: route({
        top: candidate({ action: "review", score: 0.4 }),
        confidence: 0.5,
        noMatch: true,
      }),
    }))).toBe("L2-judge");
  });
});

describe("formatConfidence", () => {
  it("rounds to integer percentage", () => {
    expect(formatConfidence(0.86)).toBe("86%");
    expect(formatConfidence(0)).toBe("0%");
    expect(formatConfidence(1)).toBe("100%");
  });

  it("returns em dash for non-finite values", () => {
    expect(formatConfidence(Number.NaN)).toBe("—");
    expect(formatConfidence(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("deriveIntentDiagnosticsRow", () => {
  it("formats action label, layer label, confidence, matched example, and patch", () => {
    const row = deriveIntentDiagnosticsRow(entry({
      decision: decision({
        action: "approve_node",
        confidence: 0.86,
        reason: "用户要求执行当前任务。",
        patch: {
          executionMode: "execute_directly",
          debateRequested: false,
          reviewRequested: false,
          objective: "实现新功能",
        },
      }),
      route: route({
        top: candidate({ action: "execute", score: 0.78 }),
        confidence: 0.78,
        noMatch: false,
      }),
    }));

    expect(row.layer).toBe("L1-semantic");
    expect(row.layerLabel).toBe("L1 语义路由");
    expect(row.actionLabel).toBe("放行执行");
    expect(row.confidenceText).toBe("86%");
    expect(row.reasonText).toBe("用户要求执行当前任务。");
    expect(row.matchedExampleText).toContain("解释一下");
    expect(row.matchedExampleText).toContain("score=0.78");
    expect(row.patchSummary).toContain("模式=execute_directly");
    expect(row.patchSummary).toContain("目标=实现新功能");
  });

  it("returns null patch summary when patch is empty", () => {
    const row = deriveIntentDiagnosticsRow(entry({}));
    expect(row.patchSummary).toBeNull();
  });

  it("marks answer_only / start_run / non-null targetRunId as state-machine accepted", () => {
    expect(deriveIntentDiagnosticsRow(entry({ decision: decision({ action: "answer_only", targetRunId: "run-1" }) })).stateMachineAccepted).toBe(true);
    expect(deriveIntentDiagnosticsRow(entry({ decision: decision({ action: "start_run", targetRunId: null }) })).stateMachineAccepted).toBe(true);
    expect(deriveIntentDiagnosticsRow(entry({ decision: decision({ action: "continue_run", targetRunId: null }) })).stateMachineAccepted).toBe(false);
  });
});

describe("deriveIntentDiagnosticsRows", () => {
  it("preserves order and maps each entry", () => {
    const rows = deriveIntentDiagnosticsRows([
      entry({ id: "a" }),
      entry({ id: "b" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
