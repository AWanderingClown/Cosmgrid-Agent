import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DebateResult } from "../debate-engine";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../../db", () => ({
  debateSessions: {
    create: mocks.create,
  },
}));

import { archiveDynamicDebateResult } from "../debate-persistence";

const result: DebateResult = {
  topic: "should we persist debates?",
  finalSolution: "yes",
  rounds: [
    {
      role: "solver",
      modelId: "m-a",
      content: "proposal",
      inputTokens: 10,
      outputTokens: 20,
    },
    {
      role: "judge",
      modelId: "m-b",
      content: "verdict",
      inputTokens: 5,
      outputTokens: 8,
    },
  ],
};

describe("archiveDynamicDebateResult", () => {
  beforeEach(() => {
    mocks.create.mockReset();
  });

  it("saves dynamic chat debate results in debate_sessions format", async () => {
    mocks.create.mockResolvedValueOnce("debate-1");

    await expect(archiveDynamicDebateResult({
      projectId: "project-1",
      result,
    })).resolves.toBe("debate-1");

    expect(mocks.create).toHaveBeenCalledWith({
      projectId: "project-1",
      topic: result.topic,
      quickMode: false,
      rounds: result.rounds,
      finalSolution: result.finalSolution,
      status: "completed",
    });
  });

  it("does not fail the visible chat debate when archiving fails", async () => {
    mocks.create.mockRejectedValueOnce(new Error("database locked"));

    await expect(archiveDynamicDebateResult({
      projectId: null,
      result,
    })).resolves.toBeNull();
  });
});
