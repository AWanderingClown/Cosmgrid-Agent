import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  computeDecayPlan,
  decayStaleIntentExamples,
  downweightMisjudgedExampleInDb,
  findMisjudgedExampleToDownweight,
  DECAY_FACTOR,
  DECAY_THRESHOLD_DAYS,
  MIN_WEIGHT_BEFORE_DISABLE,
  MISJUDGE_DOWNWEIGHT_FACTOR,
} from "../intent-decay";
import { BUILTIN_INTENT_EXAMPLES, type IntentExample } from "../semantic-intent-router";
import type { StoredIntentExample } from "@/lib/db";

const mocks = vi.hoisted(() => ({
  setExampleEnabled: vi.fn(),
  updateExampleWeight: vi.fn(),
  listExamples: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  intentLearning: {
    setExampleEnabled: mocks.setExampleEnabled,
    updateExampleWeight: mocks.updateExampleWeight,
    listExamples: mocks.listExamples,
  },
}));

function storedExample(over: Partial<StoredIntentExample> & { id: string }): StoredIntentExample {
  return {
    action: "debate",
    text: "让几个模型互相反驳",
    explanation: "",
    source: "user_correction",
    confidence: 0.9,
    weight: 1,
    enabled: true,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setExampleEnabled.mockResolvedValue(undefined);
  mocks.updateExampleWeight.mockResolvedValue(undefined);
  mocks.listExamples.mockResolvedValue([]);
});

describe("findMisjudgedExampleToDownweight", () => {
  it("命中一条用户纠正样例时，按 MISJUDGE_DOWNWEIGHT_FACTOR 打折", () => {
    const stored: IntentExample = {
      id: "stored-debate-1",
      action: "debate",
      text: "让几个模型互相反驳，最后裁判",
      explanation: "用户纠正过的样例",
      source: "user_correction",
      weight: 1.25,
      enabled: true,
    };
    const examples = [...BUILTIN_INTENT_EXAMPLES, stored];
    const result = findMisjudgedExampleToDownweight(
      "让几个模型互相反驳，最后裁判一下",
      "debate",
      examples,
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe("stored-debate-1");
    expect(result!.nextWeight).toBeCloseTo(1.25 * MISJUDGE_DOWNWEIGHT_FACTOR, 5);
    expect(result!.disabled).toBe(false);
  });

  it("命中的是内置样例（source=builtin）时不降权——内置样例不落库，改不了权重", () => {
    // debate-multi-model 是 BUILTIN_INTENT_EXAMPLES 里唯一强命中 debate 的样例
    const result = findMisjudgedExampleToDownweight(
      "让几个模型站不同立场互相反驳，最后给裁判结论",
      "debate",
      BUILTIN_INTENT_EXAMPLES,
    );
    expect(result).toBeNull();
  });

  it("权重打折后跌破 MIN_WEIGHT_BEFORE_DISABLE 时标记为该禁用", () => {
    const lowWeightStored: IntentExample = {
      id: "stored-low",
      action: "debate",
      text: "让几个模型互相反驳，最后裁判",
      explanation: "",
      source: "user_correction",
      weight: 0.5, // 0.5 * 0.7 = 0.35 < 0.4 阈值
      enabled: true,
    };
    const result = findMisjudgedExampleToDownweight(
      "让几个模型互相反驳，最后裁判一下",
      "debate",
      [lowWeightStored],
    );
    expect(result).not.toBeNull();
    expect(result!.disabled).toBe(true);
    expect(result!.nextWeight).toBeLessThan(MIN_WEIGHT_BEFORE_DISABLE);
  });

  it("predictedAction 在候选里完全没有匹配时返回 null", () => {
    const result = findMisjudgedExampleToDownweight("随便说点什么完全不相关的话", "cancel_run", []);
    expect(result).toBeNull();
  });
});

describe("computeDecayPlan", () => {
  it("超过 DECAY_THRESHOLD_DAYS 未更新的非内置样例会被衰减", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const stale = storedExample({ id: "stale-1", updatedAt: "2026-06-01T00:00:00.000Z", weight: 1 });
    const plan = computeDecayPlan([stale], now);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.id).toBe("stale-1");
    expect(plan[0]!.nextWeight).toBeCloseTo(1 * DECAY_FACTOR, 5);
  });

  it("未超过阈值天数的样例不衰减", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const fresh = storedExample({ id: "fresh-1", updatedAt: "2026-06-01T00:00:00.000Z" });
    const plan = computeDecayPlan([fresh], now);
    expect(plan).toHaveLength(0);
  });

  it("恰好等于阈值天数时也判定为该衰减（边界含）", () => {
    const now = new Date(
      new Date("2026-06-01T00:00:00.000Z").getTime() + DECAY_THRESHOLD_DAYS * 86_400_000,
    );
    const boundary = storedExample({ id: "boundary-1", updatedAt: "2026-06-01T00:00:00.000Z" });
    const plan = computeDecayPlan([boundary], now);
    expect(plan).toHaveLength(1);
  });

  it("内置样例（source=builtin）永远不参与衰减", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const builtinLike = storedExample({ id: "b1", source: "builtin", updatedAt: "2026-01-01T00:00:00.000Z" });
    const plan = computeDecayPlan([builtinLike], now);
    expect(plan).toHaveLength(0);
  });

  it("多次衰减后权重跌破阈值会标记为禁用", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const nearlyDead = storedExample({ id: "nearly-dead", weight: 0.5, updatedAt: "2026-01-01T00:00:00.000Z" });
    const plan = computeDecayPlan([nearlyDead], now);
    expect(plan[0]!.disabled).toBe(0.5 * DECAY_FACTOR < MIN_WEIGHT_BEFORE_DISABLE);
  });
});

describe("downweightMisjudgedExampleInDb", () => {
  it("纯函数返回 null 时 → 不写库，直接返回 null", async () => {
    // BUILTIN_INTENT_EXAMPLES 单跑 builtin 命中 → 纯函数返回 null
    const r = await downweightMisjudgedExampleInDb(
      "让几个模型互相反驳",
      "debate",
      BUILTIN_INTENT_EXAMPLES,
    );
    expect(r).toBeNull();
    expect(mocks.setExampleEnabled).not.toHaveBeenCalled();
    expect(mocks.updateExampleWeight).not.toHaveBeenCalled();
  });

  it("纯函数算出 adjustment 且不跌破阈值时 → 调 updateExampleWeight 写新权重", async () => {
    const stored: IntentExample = {
      id: "stored-debate-1",
      action: "debate",
      text: "让几个模型互相反驳，最后裁判",
      explanation: "",
      source: "user_correction",
      weight: 1.25,
      enabled: true,
    };
    const r = await downweightMisjudgedExampleInDb(
      "让几个模型互相反驳，最后裁判一下",
      "debate",
      [...BUILTIN_INTENT_EXAMPLES, stored],
    );
    expect(r).not.toBeNull();
    expect(mocks.updateExampleWeight).toHaveBeenCalledWith(
      "stored-debate-1",
      r!.nextWeight,
    );
    expect(mocks.setExampleEnabled).not.toHaveBeenCalled();
  });

  it("纯函数算出 adjustment 且跌破阈值 → 调 setExampleEnabled(false) 而不是 updateExampleWeight", async () => {
    const lowWeight: IntentExample = {
      id: "stored-low",
      action: "debate",
      text: "让几个模型互相反驳，最后裁判",
      explanation: "",
      source: "user_correction",
      weight: 0.5,
      enabled: true,
    };
    await downweightMisjudgedExampleInDb(
      "让几个模型互相反驳，最后裁判一下",
      "debate",
      [lowWeight],
    );
    expect(mocks.setExampleEnabled).toHaveBeenCalledWith("stored-low", false);
    expect(mocks.updateExampleWeight).not.toHaveBeenCalled();
  });
});

describe("decayStaleIntentExamples", () => {
  it("listExamples 返回空时 → 直接返回空 plan，不调任何写库", async () => {
    mocks.listExamples.mockResolvedValue([]);
    const plan = await decayStaleIntentExamples(new Date("2026-08-01T00:00:00.000Z"));
    expect(plan).toEqual([]);
    expect(mocks.updateExampleWeight).not.toHaveBeenCalled();
    expect(mocks.setExampleEnabled).not.toHaveBeenCalled();
  });

  it("包含可衰减样例 → 逐条写库，禁用和权重分流", async () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    mocks.listExamples.mockResolvedValue([
      storedExample({ id: "fresh-disabled", weight: 0.4, updatedAt: "2026-01-01T00:00:00.000Z" }), // 0.4 * 0.85 = 0.34 < 0.4 → 禁用
      storedExample({ id: "alive", weight: 1, updatedAt: "2026-06-01T00:00:00.000Z" }),            // 衰减后仍 > 0.4 → 改权重
    ]);
    const plan = await decayStaleIntentExamples(now);
    expect(plan).toHaveLength(2);
    expect(mocks.setExampleEnabled).toHaveBeenCalledWith("fresh-disabled", false);
    expect(mocks.updateExampleWeight).toHaveBeenCalledWith(
      "alive",
      1 * DECAY_FACTOR,
    );
  });

  it("包含未达阈值的样例 → 不参与衰减", async () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    mocks.listExamples.mockResolvedValue([
      storedExample({ id: "fresh", updatedAt: "2026-06-01T00:00:00.000Z" }),
    ]);
    const plan = await decayStaleIntentExamples(now);
    expect(plan).toEqual([]);
  });
});
