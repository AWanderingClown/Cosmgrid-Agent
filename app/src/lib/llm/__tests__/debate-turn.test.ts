import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildDebateParticipants: vi.fn(),
  runDynamicDebate: vi.fn(),
  archiveDynamicDebateResult: vi.fn(),
}));

vi.mock("@/lib/llm/debate-participants", () => ({
  buildDebateParticipants: mocks.buildDebateParticipants,
}));

vi.mock("@/lib/llm/debate-engine", () => ({
  runDynamicDebate: mocks.runDynamicDebate,
}));

vi.mock("@/lib/llm/debate-persistence", () => ({
  archiveDynamicDebateResult: mocks.archiveDynamicDebateResult,
}));

vi.mock("@/lib/llm/debate-runner", () => ({
  realRunRole: vi.fn(),
}));

import { executeDebateTurn } from "@/lib/llm/debate-turn";

describe("executeDebateTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails clearly when no usable participant exists", async () => {
    mocks.buildDebateParticipants.mockResolvedValue([]);

    await expect(
      executeDebateTurn({
        primaryModel: { id: "primary", name: "Primary" } as never,
        availableModels: [],
        credentials: [],
        workspacePath: null,
        messages: [],
        userMessage: { id: "user-1", role: "user", content: "debate this" },
        projectId: null,
        getApiKey: vi.fn(),
        signal: new AbortController().signal,
        t: ((key: string) =>
          key === "chat.debate.noParticipants" ? "no participants" : key) as never,
      }),
    ).rejects.toThrow("no participants");

    expect(mocks.runDynamicDebate).not.toHaveBeenCalled();
  });

  it("runs, formats, and archives one complete debate operation", async () => {
    const participants = [
      {
        role: "participant_1",
        modelId: "model-a",
        modelName: "Model A",
      },
    ];
    const result = {
      topic: "debate this",
      finalSolution: "final answer",
      rounds: [
        {
          role: "solver",
          modelId: "model-a",
          content: "draft",
          inputTokens: 5,
          outputTokens: 7,
        },
      ],
    };
    mocks.buildDebateParticipants.mockResolvedValue(participants);
    mocks.runDynamicDebate.mockResolvedValue(result);

    const output = await executeDebateTurn({
      primaryModel: {
        id: "primary",
        name: "Primary",
        displayName: "Primary Display",
      } as never,
      availableModels: [
        { id: "model-a", name: "Model A", displayName: "A" },
      ] as never,
      credentials: [],
      workspacePath: "/workspace",
      messages: [],
      userMessage: { id: "user-1", role: "user", content: "debate this" },
      projectId: "project-1",
      getApiKey: vi.fn(),
      signal: new AbortController().signal,
      t: ((key: string) => key) as never,
    });

    expect(output.participants).toBe(participants);
    expect(output.result).toBe(result);
    expect(output.content).toContain("final answer");
    expect(output.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(mocks.archiveDynamicDebateResult).toHaveBeenCalledWith({
      projectId: "project-1",
      result,
    });
  });
});
