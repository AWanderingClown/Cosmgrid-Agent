import { getDb } from "./connection";
import { newId, now } from "./utils";
import type { HarnessCandidateSurface } from "@/lib/llm/harness/candidates/candidate-manager";

export type HarnessCandidateStatus = "proposed" | "evaluating" | "pending_approval" | "accepted" | "rejected" | "rolled_back";

export interface HarnessVersionRow {
  id: string;
  version: string;
  parentVersionId: string | null;
  active: boolean;
  createdAt: string;
}

export interface HarnessCandidateRow {
  id: string;
  parentVersionId: string;
  targetFailureKind: string;
  expectedImprovement: string;
  riskSummary: string;
  status: HarnessCandidateStatus;
  heldInResultJson: string | null;
  heldOutResultJson: string | null;
  costDeltaJson: string | null;
  decisionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessCandidateEditRow {
  id: string;
  candidateId: string;
  surface: HarnessCandidateSurface;
  diff: string;
  createdAt: string;
}

function mapVersionRow(r: any): HarnessVersionRow {
  return { id: r.id, version: r.version, parentVersionId: r.parent_version_id, active: !!r.active, createdAt: r.created_at };
}

function mapCandidateRow(r: any): HarnessCandidateRow {
  return {
    id: r.id,
    parentVersionId: r.parent_version_id,
    targetFailureKind: r.target_failure_kind,
    expectedImprovement: r.expected_improvement,
    riskSummary: r.risk_summary,
    status: r.status,
    heldInResultJson: r.held_in_result_json,
    heldOutResultJson: r.held_out_result_json,
    costDeltaJson: r.cost_delta_json,
    decisionReason: r.decision_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapEditRow(r: any): HarnessCandidateEditRow {
  return { id: r.id, candidateId: r.candidate_id, surface: r.surface, diff: r.diff, createdAt: r.created_at };
}

export const harnessVersions = {
  async create(input: { version: string; parentVersionId?: string | null; active?: boolean }): Promise<string> {
    const db = await getDb();
    const id = newId();
    if (input.active) {
      await db.execute("UPDATE harness_versions SET active = 0");
    }
    await db.execute(
      "INSERT INTO harness_versions (id, version, parent_version_id, active, created_at) VALUES ($1,$2,$3,$4,$5)",
      [id, input.version, input.parentVersionId ?? null, input.active ? 1 : 0, now()],
    );
    return id;
  },

  async setActive(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE harness_versions SET active = 0");
    await db.execute("UPDATE harness_versions SET active = 1 WHERE id = $1", [id]);
  },

  async getActive(): Promise<HarnessVersionRow | null> {
    const db = await getDb();
    const rows = await db.select<any[]>("SELECT * FROM harness_versions WHERE active = 1 ORDER BY created_at DESC LIMIT 1");
    return rows[0] ? mapVersionRow(rows[0]) : null;
  },
};

export const harnessCandidates = {
  async create(input: {
    parentVersionId: string;
    targetFailureKind: string;
    expectedImprovement: string;
    riskSummary: string;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO harness_candidates
        (id, parent_version_id, target_failure_kind, expected_improvement, risk_summary, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'proposed',$6,$7)`,
      [id, input.parentVersionId, input.targetFailureKind, input.expectedImprovement, input.riskSummary, ts, ts],
    );
    return id;
  },

  async getById(id: string): Promise<HarnessCandidateRow | null> {
    const db = await getDb();
    const rows = await db.select<any[]>("SELECT * FROM harness_candidates WHERE id = $1 LIMIT 1", [id]);
    return rows[0] ? mapCandidateRow(rows[0]) : null;
  },

  async updateDecision(id: string, patch: {
    status: HarnessCandidateStatus;
    decisionReason: string;
    heldInResultJson?: string | null;
    heldOutResultJson?: string | null;
    costDeltaJson?: string | null;
  }): Promise<void> {
    const db = await getDb();
    await db.execute(
      `UPDATE harness_candidates
       SET status = $1, decision_reason = $2, held_in_result_json = COALESCE($3, held_in_result_json),
           held_out_result_json = COALESCE($4, held_out_result_json), cost_delta_json = COALESCE($5, cost_delta_json),
           updated_at = $6
       WHERE id = $7`,
      [
        patch.status,
        patch.decisionReason,
        patch.heldInResultJson ?? null,
        patch.heldOutResultJson ?? null,
        patch.costDeltaJson ?? null,
        now(),
        id,
      ],
    );
  },
};

export const harnessCandidateEdits = {
  async create(input: { candidateId: string; surface: HarnessCandidateSurface; diff: string }): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      "INSERT INTO harness_candidate_edits (id, candidate_id, surface, diff, created_at) VALUES ($1,$2,$3,$4,$5)",
      [id, input.candidateId, input.surface, input.diff, now()],
    );
    return id;
  },

  async listByCandidate(candidateId: string): Promise<HarnessCandidateEditRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM harness_candidate_edits WHERE candidate_id = $1 ORDER BY created_at ASC",
      [candidateId],
    );
    return rows.map(mapEditRow);
  },
};
