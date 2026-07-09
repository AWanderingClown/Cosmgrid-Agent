import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendIntentDiagnostics,
  clearIntentDiagnostics,
  INTENT_DIAGNOSTICS_BUFFER_KEY,
  INTENT_DIAGNOSTICS_MAX,
  readIntentDiagnostics,
  subscribeIntentDiagnostics,
  type IntentDiagnosticsEntry,
} from "../intent-diagnostics-buffer";
import type { TurnIntentDecision } from "../types";
import type { SemanticIntentRoute } from "../semantic-intent-router";

function decision(overrides: Partial<TurnIntentDecision> = {}): TurnIntentDecision {
  return {
    action: "answer_only",
    targetRunId: null,
    confidence: 0.9,
    reason: "测试原因",
    evidenceTurnIds: [],
    ...overrides,
  };
}

function route(): SemanticIntentRoute {
  return { candidates: [], top: null, confidence: 0, noMatch: true };
}

function entry(overrides: Partial<IntentDiagnosticsEntry> = {}): IntentDiagnosticsEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt: new Date().toISOString(),
    userTextExcerpt: "测试文本",
    decision: decision(),
    route: route(),
    ...overrides,
  };
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("intent-diagnostics-buffer", () => {
  beforeEach(() => {
    // vitest 默认 node 环境；mock 一个最小 sessionStorage 接口（项目 vitest.config.ts 设 environment: node）
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = createMemoryStorage();
  });

  afterEach(() => {
    delete (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage;
  });

  it("returns empty list when sessionStorage has nothing", () => {
    expect(readIntentDiagnostics()).toEqual([]);
  });

  it("appends an entry and reads it back", () => {
    appendIntentDiagnostics(entry({ id: "a" }));
    const list = readIntentDiagnostics();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("a");
  });

  it("keeps only the last INTENT_DIAGNOSTICS_MAX entries (FIFO drop)", () => {
    for (let i = 0; i < INTENT_DIAGNOSTICS_MAX + 5; i += 1) {
      appendIntentDiagnostics(entry({ id: `e-${i}` }));
    }
    const list = readIntentDiagnostics();
    expect(list).toHaveLength(INTENT_DIAGNOSTICS_MAX);
    expect(list[0].id).toBe(`e-${5}`);
    expect(list[list.length - 1].id).toBe(`e-${INTENT_DIAGNOSTICS_MAX + 4}`);
  });

  it("persists across read calls (sessionStorage round-trip)", () => {
    appendIntentDiagnostics(entry({ id: "persist-1" }));
    appendIntentDiagnostics(entry({ id: "persist-2" }));
    const list = readIntentDiagnostics();
    expect(list.map((e) => e.id)).toEqual(["persist-1", "persist-2"]);
  });

  it("clear removes everything and notifies listeners", () => {
    appendIntentDiagnostics(entry({ id: "x" }));
    let received: readonly IntentDiagnosticsEntry[] | null = null;
    const unsubscribe = subscribeIntentDiagnostics((next) => {
      received = next;
    });
    clearIntentDiagnostics();
    unsubscribe();
    expect(readIntentDiagnostics()).toEqual([]);
    expect(received).toEqual([]);
  });

  it("subscribe listener fires on append with the full list", () => {
    const calls: (readonly IntentDiagnosticsEntry[])[] = [];
    const unsubscribe = subscribeIntentDiagnostics((next) => calls.push(next));
    appendIntentDiagnostics(entry({ id: "y-1" }));
    appendIntentDiagnostics(entry({ id: "y-2" }));
    unsubscribe();
    expect(calls).toHaveLength(2);
    expect(calls[1].map((e) => e.id)).toEqual(["y-1", "y-2"]);
  });

  it("ignores malformed JSON in sessionStorage without throwing", () => {
    sessionStorage.setItem(INTENT_DIAGNOSTICS_BUFFER_KEY, "{not json");
    expect(() => readIntentDiagnostics()).not.toThrow();
    expect(readIntentDiagnostics()).toEqual([]);
  });

  it("filters out entries that don't match the expected shape", () => {
    sessionStorage.setItem(INTENT_DIAGNOSTICS_BUFFER_KEY, JSON.stringify([
      { id: "good", capturedAt: "2026-07-09", userTextExcerpt: "", decision: decision(), route: route() },
      { garbage: true },
      null,
    ]));
    const list = readIntentDiagnostics();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("good");
  });
});
