export type AgentJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "merged";

export interface AgentJobSnapshot {
  id: string;
  parentJobId: string | null;
  workflowRunId: string | null;
  role: string;
  modelId: string | null;
  status: AgentJobStatus;
  objective: string;
  inputContextRefsJson: string;
  outputArtifactRefsJson: string;
  startedAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
  retryCount: number;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MergedJobResult {
  childJobIds: string[];
  sourceModelIds: string[];
  artifactRefs: string[];
}
