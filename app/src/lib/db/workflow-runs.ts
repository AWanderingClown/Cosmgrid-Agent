import type { WorkflowRunStatus, WorkflowSnapshot } from "../workflow/types";
import { deriveWorkflowAuditSummary, type WorkflowAuditSummary } from "./workflow-audit";
import { getDb } from "./connection";
import { newId, now } from "./utils";

// ============ workflowRuns CRUD（v0.10：持久任务工作流） ============

export interface WorkflowRunRow {
  id: string;
  conversation_id: string;
  project_id: string | null;
  status: WorkflowRunStatus;
  current_phase: string | null;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: string;
  conversationId: string;
  projectId: string | null;
  status: WorkflowRunStatus;
  currentPhase: string | null;
  snapshotJson: string;
  snapshot: WorkflowSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEventRow {
  id: string;
  workflow_run_id: string;
  conversation_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface WorkflowEvent {
  id: string;
  workflowRunId: string;
  conversationId: string;
  eventType: string;
  payloadJson: string;
  createdAt: string;
}

function currentPhaseOf(snapshot: WorkflowSnapshot): string | null {
  const node = snapshot.nodes.find((n) => n.id === snapshot.currentNodeId);
  return node?.phase ?? null;
}

function mapWorkflowRunRow(r: WorkflowRunRow): WorkflowRun {
  const snapshot = JSON.parse(r.snapshot_json) as WorkflowSnapshot;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    projectId: r.project_id,
    status: r.status,
    currentPhase: r.current_phase,
    snapshotJson: r.snapshot_json,
    snapshot,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapWorkflowEventRow(r: WorkflowEventRow): WorkflowEvent {
  return {
    id: r.id,
    workflowRunId: r.workflow_run_id,
    conversationId: r.conversation_id,
    eventType: r.event_type,
    payloadJson: r.payload_json,
    createdAt: r.created_at,
  };
}

export const workflowRuns = {
  async create(input: {
    conversationId: string;
    projectId?: string | null;
    snapshot: WorkflowSnapshot;
  }): Promise<WorkflowRun> {
    const db = await getDb();
    const ts = now();
    const snapshotJson = JSON.stringify(input.snapshot);
    const currentPhase = currentPhaseOf(input.snapshot);
    await db.execute(
      `INSERT INTO workflow_runs
        (id, conversation_id, project_id, status, current_phase, snapshot_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.snapshot.runId,
        input.conversationId,
        input.projectId ?? input.snapshot.projectId ?? null,
        input.snapshot.status,
        currentPhase,
        snapshotJson,
        ts,
        ts,
      ],
    );
    await this.appendEvent({
      workflowRunId: input.snapshot.runId,
      conversationId: input.conversationId,
      eventType: "workflow.created",
      payload: { status: input.snapshot.status, currentPhase },
    });
    const rows = await db.select<WorkflowRunRow[]>("SELECT * FROM workflow_runs WHERE id = $1", [input.snapshot.runId]);
    return mapWorkflowRunRow(rows[0]!);
  },

  async getById(id: string): Promise<WorkflowRun | null> {
    const db = await getDb();
    const rows = await db.select<WorkflowRunRow[]>("SELECT * FROM workflow_runs WHERE id = $1 LIMIT 1", [id]);
    return rows[0] ? mapWorkflowRunRow(rows[0]) : null;
  },

  async getActiveByConversation(conversationId: string): Promise<WorkflowRun | null> {
    const db = await getDb();
    const rows = await db.select<WorkflowRunRow[]>(
      `SELECT * FROM workflow_runs
       WHERE conversation_id = $1 AND status IN ('running', 'waiting_user', 'paused')
       ORDER BY updated_at DESC
       LIMIT 1`,
      [conversationId],
    );
    return rows[0] ? mapWorkflowRunRow(rows[0]) : null;
  },

  async saveSnapshot(input: {
    runId: string;
    snapshot: WorkflowSnapshot;
    eventType?: string;
    eventPayload?: unknown;
  }): Promise<void> {
    const db = await getDb();
    const snapshotJson = JSON.stringify(input.snapshot);
    const currentPhase = currentPhaseOf(input.snapshot);
    const ts = now();
    await db.execute(
      `UPDATE workflow_runs
       SET status = $1, current_phase = $2, snapshot_json = $3, updated_at = $4
       WHERE id = $5`,
      [input.snapshot.status, currentPhase, snapshotJson, ts, input.runId],
    );
    if (input.eventType) {
      await this.appendEvent({
        workflowRunId: input.runId,
        conversationId: input.snapshot.conversationId,
        eventType: input.eventType,
        payload: input.eventPayload ?? { status: input.snapshot.status, currentPhase },
      });
    }
  },

  async appendEvent(input: {
    workflowRunId: string;
    conversationId: string;
    eventType: string;
    payload: unknown;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO workflow_events
        (id, workflow_run_id, conversation_id, event_type, payload_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.workflowRunId, input.conversationId, input.eventType, JSON.stringify(input.payload), now()],
    );
    return id;
  },

  async listEvents(workflowRunId: string): Promise<WorkflowEvent[]> {
    const db = await getDb();
    const rows = await db.select<WorkflowEventRow[]>(
      "SELECT * FROM workflow_events WHERE workflow_run_id = $1 ORDER BY created_at ASC",
      [workflowRunId],
    );
    return rows.map(mapWorkflowEventRow);
  },

  async getAuditSummary(workflowRunId: string): Promise<WorkflowAuditSummary | null> {
    const run = await this.getById(workflowRunId);
    if (!run) return null;
    const events = await this.listEvents(workflowRunId);
    return deriveWorkflowAuditSummary({
      snapshot: run.snapshot,
      events: events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        createdAt: event.createdAt,
        payloadJson: event.payloadJson,
      })),
    });
  },
};
