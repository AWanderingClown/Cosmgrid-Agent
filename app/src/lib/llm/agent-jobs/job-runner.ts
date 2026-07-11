import { agentJobs } from "@/lib/db";
import type { RunRole, RunRoleParams } from "@/lib/llm/debate-engine";
import { runConcurrentJobs } from "./job-manager";

export interface RunAgentJobTaskInput {
  workflowRunId?: string | null;
  parentJobId?: string | null;
  role: string;
  modelId?: string | null;
  objective: string;
  inputContextRefs?: string[];
}

export interface AgentJobTaskResult<T> {
  value: T;
  outputArtifactRefs?: string[];
}

export async function runAgentJobTask<T>(
  input: RunAgentJobTaskInput,
  task: (jobId: string) => Promise<T | AgentJobTaskResult<T>>,
): Promise<{ jobId: string; value: T }> {
  const jobId = await agentJobs.start({
    parentJobId: input.parentJobId ?? null,
    workflowRunId: input.workflowRunId ?? null,
    role: input.role,
    modelId: input.modelId ?? null,
    objective: input.objective,
    inputContextRefsJson: JSON.stringify(input.inputContextRefs ?? []),
  });

  try {
    const raw = await task(jobId);
    const normalized = normalizeTaskResult(raw);
    await agentJobs.finish(jobId, {
      status: "succeeded",
      outputArtifactRefsJson: JSON.stringify(normalized.outputArtifactRefs ?? []),
    });
    return { jobId, value: normalized.value };
  } catch (err) {
    const failureCode = err instanceof Error && err.name === "AbortError" ? "ABORTED" : "TASK_FAILED";
    await agentJobs.finish(jobId, { status: "failed", failureCode });
    throw err;
  }
}

export function createJobBackedRunRole(input: {
  workflowRunId: string | null;
  runRole: RunRole;
}): RunRole {
  if (!input.workflowRunId) return input.runRole;
  return async (params: RunRoleParams) => {
    const { value } = await runAgentJobTask(
      {
        workflowRunId: input.workflowRunId,
        role: params.config.role,
        modelId: params.config.modelId,
        objective: `debate:${params.config.role}`,
        inputContextRefs: [
          `provider:${params.config.providerId}`,
          `model:${params.config.modelName}`,
        ],
      },
      async () => ({
        value: await input.runRole(params),
        outputArtifactRefs: [
          `debate-role:${params.config.role}:${params.config.modelId}`,
        ],
      }),
    );
    return value;
  };
}

export async function runProjectAuditExplorationJobs<T>(input: {
  workflowRunId: string;
  parentJobId?: string | null;
  modelId?: string | null;
  objectives: Array<{ id: string; role: string; objective: string; inputContextRefs?: string[] }>;
  runExplorer: (objective: { id: string; role: string; objective: string; inputContextRefs: string[] }, jobId: string) => Promise<T>;
}): Promise<Array<{ id: string; status: "fulfilled"; value: T } | { id: string; status: "rejected"; reason: string }>> {
  return runConcurrentJobs(
    input.objectives.map((objective) => ({
      id: objective.id,
      run: async () => {
        const { value } = await runAgentJobTask(
          {
            workflowRunId: input.workflowRunId,
            parentJobId: input.parentJobId ?? null,
            role: objective.role,
            modelId: input.modelId ?? null,
            objective: objective.objective,
            inputContextRefs: objective.inputContextRefs ?? [],
          },
          async (jobId) => input.runExplorer(
            {
              id: objective.id,
              role: objective.role,
              objective: objective.objective,
              inputContextRefs: objective.inputContextRefs ?? [],
            },
            jobId,
          ),
        );
        return value;
      },
    })),
  );
}

function normalizeTaskResult<T>(raw: T | AgentJobTaskResult<T>): AgentJobTaskResult<T> {
  if (
    raw &&
    typeof raw === "object" &&
    "value" in raw &&
    (Object.keys(raw as unknown as Record<string, unknown>).length === 1 ||
      "outputArtifactRefs" in raw)
  ) {
    return raw as AgentJobTaskResult<T>;
  }
  return { value: raw as T };
}
