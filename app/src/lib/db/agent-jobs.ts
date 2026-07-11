import { getDb } from "./connection";
import { newId, now } from "./utils";
import type { AgentJobStatus } from "@/lib/llm/agent-jobs/types";

export interface AgentJobRow {
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

export interface AgentJobEventRow {
  id: string;
  jobId: string;
  eventType: string;
  payloadJson: string;
  createdAt: string;
}

export interface AgentJobArtifactRow {
  id: string;
  jobId: string;
  kind: string;
  uri: string;
  summary: string;
  createdAt: string;
}

function mapJobRow(r: any): AgentJobRow {
  return {
    id: r.id,
    parentJobId: r.parent_job_id,
    workflowRunId: r.workflow_run_id,
    role: r.role,
    modelId: r.model_id,
    status: r.status,
    objective: r.objective,
    inputContextRefsJson: r.input_context_refs_json,
    outputArtifactRefsJson: r.output_artifact_refs_json,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    failureCode: r.failure_code,
    retryCount: r.retry_count,
    cancellationReason: r.cancellation_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapEventRow(r: any): AgentJobEventRow {
  return { id: r.id, jobId: r.job_id, eventType: r.event_type, payloadJson: r.payload_json, createdAt: r.created_at };
}

function mapArtifactRow(r: any): AgentJobArtifactRow {
  return { id: r.id, jobId: r.job_id, kind: r.kind, uri: r.uri, summary: r.summary, createdAt: r.created_at };
}

export const agentJobs = {
  async start(input: {
    parentJobId?: string | null;
    workflowRunId?: string | null;
    role: string;
    modelId?: string | null;
    objective: string;
    inputContextRefsJson?: string;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO agent_jobs
        (id, parent_job_id, workflow_run_id, role, model_id, status, objective,
         input_context_refs_json, output_artifact_refs_json, started_at, retry_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'running',$6,$7,'[]',$8,0,$9,$10)`,
      [
        id,
        input.parentJobId ?? null,
        input.workflowRunId ?? null,
        input.role,
        input.modelId ?? null,
        input.objective,
        input.inputContextRefsJson ?? "[]",
        ts,
        ts,
        ts,
      ],
    );
    await this.recordEvent(id, "started", { role: input.role, modelId: input.modelId ?? null });
    return id;
  },

  async getById(id: string): Promise<AgentJobRow | null> {
    const db = await getDb();
    const rows = await db.select<any[]>("SELECT * FROM agent_jobs WHERE id = $1 LIMIT 1", [id]);
    return rows[0] ? mapJobRow(rows[0]) : null;
  },

  async listByWorkflow(workflowRunId: string): Promise<AgentJobRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM agent_jobs WHERE workflow_run_id = $1 ORDER BY created_at ASC",
      [workflowRunId],
    );
    return rows.map(mapJobRow);
  },

  async listActive(): Promise<AgentJobRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM agent_jobs WHERE status IN ('queued','running') ORDER BY created_at ASC",
    );
    return rows.map(mapJobRow);
  },

  async finish(
    id: string,
    patch: { status: Exclude<AgentJobStatus, "queued" | "running">; failureCode?: string | null; outputArtifactRefsJson?: string },
  ): Promise<void> {
    const db = await getDb();
    const ts = now();
    await db.execute(
      `UPDATE agent_jobs
       SET status = $1, failure_code = $2, output_artifact_refs_json = COALESCE($3, output_artifact_refs_json),
           completed_at = $4, updated_at = $5
       WHERE id = $6`,
      [patch.status, patch.failureCode ?? null, patch.outputArtifactRefsJson ?? null, ts, ts, id],
    );
    await this.recordEvent(id, patch.status, { failureCode: patch.failureCode ?? null });
  },

  async cancel(id: string, reason: string): Promise<void> {
    const db = await getDb();
    const ts = now();
    await db.execute(
      `UPDATE agent_jobs
       SET status = 'cancelled', cancellation_reason = $1, completed_at = $2, updated_at = $3
       WHERE id = $4 AND status IN ('queued','running')`,
      [reason, ts, ts, id],
    );
    await this.recordEvent(id, "cancelled", { reason });
  },

  async retry(id: string): Promise<void> {
    const db = await getDb();
    const ts = now();
    await db.execute(
      `UPDATE agent_jobs
       SET status = 'running', retry_count = retry_count + 1, failure_code = NULL,
           cancellation_reason = NULL, completed_at = NULL, started_at = $1, updated_at = $2
       WHERE id = $3`,
      [ts, ts, id],
    );
    await this.recordEvent(id, "retried", {});
  },

  async recordEvent(jobId: string, eventType: string, payload: unknown): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      "INSERT INTO agent_job_events (id, job_id, event_type, payload_json, created_at) VALUES ($1,$2,$3,$4,$5)",
      [id, jobId, eventType, JSON.stringify(payload), now()],
    );
    return id;
  },

  async listEvents(jobId: string): Promise<AgentJobEventRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM agent_job_events WHERE job_id = $1 ORDER BY created_at ASC",
      [jobId],
    );
    return rows.map(mapEventRow);
  },

  async addArtifact(jobId: string, input: { kind: string; uri: string; summary: string }): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      "INSERT INTO agent_job_artifacts (id, job_id, kind, uri, summary, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, jobId, input.kind, input.uri, input.summary, now()],
    );
    return id;
  },

  async listArtifacts(jobId: string): Promise<AgentJobArtifactRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM agent_job_artifacts WHERE job_id = $1 ORDER BY created_at ASC",
      [jobId],
    );
    return rows.map(mapArtifactRow);
  },
};
