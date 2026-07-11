import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  finish: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  agentJobs: {
    start: mocks.start,
    finish: mocks.finish,
  },
}));

import {
  createJobBackedRunRole,
  runAgentJobTask,
  runProjectAuditExplorationJobs,
} from "../job-runner";

describe("agent job runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.start.mockResolvedValue("job-1");
  });

  it("wraps a task with persisted job lifecycle events", async () => {
    const result = await runAgentJobTask(
      {
        workflowRunId: "run-1",
        role: "critic",
        modelId: "model-a",
        objective: "review",
        inputContextRefs: ["ctx-a"],
      },
      async () => ({ value: "done", outputArtifactRefs: ["artifact-a"] }),
    );

    expect(result).toEqual({ jobId: "job-1", value: "done" });
    expect(mocks.start).toHaveBeenCalledWith({
      parentJobId: null,
      workflowRunId: "run-1",
      role: "critic",
      modelId: "model-a",
      objective: "review",
      inputContextRefsJson: JSON.stringify(["ctx-a"]),
    });
    expect(mocks.finish).toHaveBeenCalledWith("job-1", {
      status: "succeeded",
      outputArtifactRefsJson: JSON.stringify(["artifact-a"]),
    });
  });

  it("marks failed task jobs without hiding the original error", async () => {
    await expect(runAgentJobTask(
      { workflowRunId: "run-1", role: "critic", objective: "review" },
      async () => {
        throw new Error("bad task");
      },
    )).rejects.toThrow("bad task");

    expect(mocks.finish).toHaveBeenCalledWith("job-1", {
      status: "failed",
      failureCode: "TASK_FAILED",
    });
  });

  it("backs debate role execution with a job when workflow run exists", async () => {
    const runRole = vi.fn(async () => ({ content: "critique", inputTokens: 3, outputTokens: 5 }));
    const wrapped = createJobBackedRunRole({ workflowRunId: "run-1", runRole });

    const result = await wrapped({
      systemPrompt: "sys",
      userPrompt: "user",
      config: {
        role: "critic",
        modelId: "m1",
        modelName: "Model 1",
        providerId: "p1",
        providerType: "openai-compatible",
        apiCredentialId: "cred-1",
        apiKey: "key",
      },
    });

    expect(result).toEqual({ content: "critique", inputTokens: 3, outputTokens: 5 });
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      workflowRunId: "run-1",
      role: "critic",
      modelId: "m1",
      objective: "debate:critic",
    }));
  });

  it("runs project audit exploration objectives as observable child jobs", async () => {
    mocks.start
      .mockResolvedValueOnce("job-code")
      .mockResolvedValueOnce("job-test");

    const result = await runProjectAuditExplorationJobs({
      workflowRunId: "run-audit",
      modelId: "model-a",
      objectives: [
        { id: "code", role: "project_audit.code", objective: "read code", inputContextRefs: ["repo"] },
        { id: "tests", role: "project_audit.tests", objective: "read tests" },
      ],
      runExplorer: async (objective, jobId) => `${objective.id}:${jobId}`,
    });

    expect(result).toEqual([
      { id: "code", status: "fulfilled", value: "code:job-code" },
      { id: "tests", status: "fulfilled", value: "tests:job-test" },
    ]);
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });
});
