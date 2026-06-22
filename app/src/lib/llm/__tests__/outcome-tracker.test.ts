// outcome-tracker 单测（改进-1 Step B：隐式反馈编排）
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  setOutcomeForLatest: vi.fn(),
  recordOutcomeSignal: vi.fn(),
}));

vi.mock("../../db", () => ({
  usageEvents: { setOutcomeForLatest: mocks.setOutcomeForLatest },
}));
vi.mock("../model-performance-stats", () => ({
  recordOutcomeSignal: mocks.recordOutcomeSignal,
}));

import { applyOutcomeForLatest, isPositiveOutcome } from "../outcome-tracker";

describe("isPositiveOutcome", () => {
  it("只有 accepted 是正反馈", () => {
    expect(isPositiveOutcome("accepted")).toBe(true);
    expect(isPositiveOutcome("retried")).toBe(false);
    expect(isPositiveOutcome("switched_up")).toBe(false);
    expect(isPositiveOutcome("reverted")).toBe(false);
    expect(isPositiveOutcome("rejected")).toBe(false);
  });
});

describe("applyOutcomeForLatest", () => {
  beforeEach(() => {
    mocks.setOutcomeForLatest.mockReset();
    mocks.recordOutcomeSignal.mockReset();
    mocks.recordOutcomeSignal.mockResolvedValue(undefined);
  });

  it("找到未评价回答 → 打标 + 负反馈喂回评分（switched_up）", async () => {
    mocks.setOutcomeForLatest.mockResolvedValue({ taskType: "hard" });
    await applyOutcomeForLatest("m-1", "switched_up");
    expect(mocks.setOutcomeForLatest).toHaveBeenCalledWith("m-1", "switched_up");
    expect(mocks.recordOutcomeSignal).toHaveBeenCalledWith("m-1", "hard", false);
  });

  it("accepted → 正反馈", async () => {
    mocks.setOutcomeForLatest.mockResolvedValue({ taskType: "standard" });
    await applyOutcomeForLatest("m-1", "accepted");
    expect(mocks.recordOutcomeSignal).toHaveBeenCalledWith("m-1", "standard", true);
  });

  it("没有未评价回答（null）→ 不喂评分", async () => {
    mocks.setOutcomeForLatest.mockResolvedValue(null);
    await applyOutcomeForLatest("m-1", "retried");
    expect(mocks.recordOutcomeSignal).not.toHaveBeenCalled();
  });

  it("taskType 为空 → 不喂评分", async () => {
    mocks.setOutcomeForLatest.mockResolvedValue({ taskType: null });
    await applyOutcomeForLatest("m-1", "retried");
    expect(mocks.recordOutcomeSignal).not.toHaveBeenCalled();
  });

  it("db 抛错 → 不抛（旁路）", async () => {
    mocks.setOutcomeForLatest.mockRejectedValue(new Error("db down"));
    await expect(applyOutcomeForLatest("m-1", "reverted")).resolves.toBeUndefined();
  });
});
