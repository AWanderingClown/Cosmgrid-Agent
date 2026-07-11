import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listEnabledByFailureKind: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  modelHarnessProfileEvents: {
    listEnabledByFailureKind: mocks.listEnabledByFailureKind,
  },
}));

import { aggregateModelWeakness, suggestAdaptationFor } from "../aggregator";

describe("aggregateModelWeakness", () => {
  beforeEach(() => {
    mocks.listEnabledByFailureKind.mockReset();
    mocks.listEnabledByFailureKind.mockResolvedValue([]);
  });

  it("turns dominant eval failures into suggested model profile entries", async () => {
    const report = await aggregateModelWeakness({
      modelId: "m1",
      modelName: "MiniMax-M3",
      minSamples: 5,
      frequencyThreshold: 0.3,
      evalFailureCounts: {
        TOOL_INVALID_PARAMS: 4,
        EVIDENCE_INSUFFICIENT: 1,
      },
    });

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      failureKind: "invalid_tool_args",
      frequency: 0.8,
      sampleCount: 4,
      suggestedAdaptation: suggestAdaptationFor("invalid_tool_args"),
    });
  });

  it("skips weak signals below minSamples", async () => {
    const report = await aggregateModelWeakness({
      modelId: null,
      modelName: "cold-model",
      minSamples: 5,
      evalFailureCounts: { TOOL_DOOM_LOOP: 2 },
    });

    expect(report.entries).toEqual([]);
  });

  it("does not suggest a failure kind that already has an enabled profile event", async () => {
    mocks.listEnabledByFailureKind.mockImplementation(async (failureKind: string, modelName: string) =>
      failureKind === "repeated_tool_call"
        ? [{ failureKind, modelName }]
        : [],
    );

    const report = await aggregateModelWeakness({
      modelId: "m1",
      modelName: "loop-model",
      minSamples: 5,
      evalFailureCounts: { TOOL_DOOM_LOOP: 5 },
    });

    expect(report.entries).toEqual([]);
    expect(report.existingEventKeys.has("repeated_tool_call::loop-model")).toBe(true);
  });

  it("combines eval, task outcome, and tool error counts into one histogram", async () => {
    const report = await aggregateModelWeakness({
      modelId: "m1",
      modelName: "mixed-model",
      minSamples: 5,
      frequencyThreshold: 0.2,
      evalFailureCounts: { TEST_FAILED: 2 },
      taskOutcomeCounts: { retryable: 2 },
      toolErrorCounts: { TOOL_DIAGNOSTIC: 1 },
    });

    expect(report.entries.map((entry) => entry.failureKind)).toEqual(
      expect.arrayContaining(["premature_completion", "repeated_tool_call", "invalid_structured_output"]),
    );
  });
});
