import type { AgentJobSnapshot, MergedJobResult } from "./types";

export interface ConcurrentJob<T> {
  id: string;
  run: () => Promise<T>;
}

export type ConcurrentJobResult<T> =
  | { id: string; status: "fulfilled"; value: T }
  | { id: string; status: "rejected"; reason: string };

export async function runConcurrentJobs<T>(jobs: ConcurrentJob<T>[]): Promise<ConcurrentJobResult<T>[]> {
  const settled = await Promise.allSettled(jobs.map((job) => job.run()));
  return settled.map((result, index) => {
    const id = jobs[index]!.id;
    if (result.status === "fulfilled") return { id, status: "fulfilled", value: result.value };
    return {
      id,
      status: "rejected",
      reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  });
}

export function markStaleRunningJobsInterrupted(jobs: AgentJobSnapshot[]): AgentJobSnapshot[] {
  return jobs.map((job) => {
    if (job.status === "running") {
      return {
        ...job,
        status: "failed",
        failureCode: "APP_RESTARTED",
        completedAt: job.completedAt ?? new Date().toISOString(),
      };
    }
    if (job.status === "queued") {
      return {
        ...job,
        status: "cancelled",
        failureCode: "APP_RESTARTED",
        cancellationReason: "App restarted before job started",
        completedAt: job.completedAt ?? new Date().toISOString(),
      };
    }
    return job;
  });
}

export function shouldCancelChildJob(parent: AgentJobSnapshot, child: AgentJobSnapshot): boolean {
  return child.parentJobId === parent.id && parent.status === "cancelled" && child.status !== "cancelled";
}

export function mergeJobResults(children: AgentJobSnapshot[]): MergedJobResult {
  return {
    childJobIds: children.map((child) => child.id),
    sourceModelIds: [...new Set(children.map((child) => child.modelId).filter((id): id is string => !!id))],
    artifactRefs: children.flatMap((child) => parseStringArray(child.outputArtifactRefsJson)),
  };
}

function parseStringArray(json: string): string[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
