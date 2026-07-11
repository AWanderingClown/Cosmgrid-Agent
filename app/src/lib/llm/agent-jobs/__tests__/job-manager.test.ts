import { describe, expect, it } from "vitest";

import {
  markStaleRunningJobsInterrupted,
  mergeJobResults,
  runConcurrentJobs,
  shouldCancelChildJob,
} from "../job-manager";
import type { AgentJobSnapshot } from "../types";

function job(overrides: Partial<AgentJobSnapshot> = {}): AgentJobSnapshot {
  return {
    id: "job-1",
    parentJobId: null,
    workflowRunId: "run-1",
    role: "critic",
    modelId: "m1",
    status: "running",
    objective: "review",
    inputContextRefsJson: "[]",
    outputArtifactRefsJson: "[]",
    startedAt: "2026-07-11T00:00:00.000Z",
    completedAt: null,
    failureCode: null,
    retryCount: 0,
    cancellationReason: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("agent job manager", () => {
  it("runs child jobs concurrently and preserves individual failures", async () => {
    const started = Date.now();
    const result = await runConcurrentJobs([
      { id: "a", run: async () => "ok-a" },
      { id: "b", run: async () => { throw new Error("bad-b"); } },
    ]);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual([
      { id: "a", status: "fulfilled", value: "ok-a" },
      { id: "b", status: "rejected", reason: "bad-b" },
    ]);
  });

  it("marks running jobs as interrupted after app restart", () => {
    expect(markStaleRunningJobsInterrupted([
      job({ id: "running", status: "running" }),
      job({ id: "queued", status: "queued" }),
      job({ id: "done", status: "succeeded" }),
    ]).map((j) => [j.id, j.status, j.failureCode])).toEqual([
      ["running", "failed", "APP_RESTARTED"],
      ["queued", "cancelled", "APP_RESTARTED"],
      ["done", "succeeded", null],
    ]);
  });

  it("cancels child jobs when parent is cancelled", () => {
    expect(shouldCancelChildJob(job({ status: "cancelled" }), job({ parentJobId: "job-1" }))).toBe(true);
    expect(shouldCancelChildJob(job({ status: "running" }), job({ parentJobId: "job-1" }))).toBe(false);
  });

  it("merges child summaries with source model and artifact refs", () => {
    const merged = mergeJobResults([
      job({ id: "a", modelId: "m-a", outputArtifactRefsJson: JSON.stringify(["artifact-a"]) }),
      job({ id: "b", modelId: "m-b", outputArtifactRefsJson: JSON.stringify(["artifact-b"]) }),
    ]);

    expect(merged).toEqual({
      childJobIds: ["a", "b"],
      sourceModelIds: ["m-a", "m-b"],
      artifactRefs: ["artifact-a", "artifact-b"],
    });
  });
});
