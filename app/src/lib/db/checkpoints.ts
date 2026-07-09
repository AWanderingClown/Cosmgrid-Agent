import { getDb } from "./connection";
import { newId, now } from "./utils";

// ============ checkpoints CRUD（4.10 / 7.12：检查点 = 给下一个 AI 的工作交接备忘录）============

interface CheckpointRow {
  id: string;
  project_id: string;
  title: string;
  goal: string | null;
  completed_summary: string | null;
  current_context: string | null;
  decisions: string | null;
  failed_attempts: string | null;
  blockers: string | null;
  next_steps: string | null;
  do_not_repeat: string | null;
  acceptance_criteria: string | null;
  created_by_model_id: string | null;
  created_at: string;
}

export interface Checkpoint {
  id: string;
  projectId: string;
  title: string;
  goal: string | null;
  completedSummary: string | null;
  currentContext: string | null;
  decisions: string | null;
  failedAttempts: string | null;
  blockers: string | null;
  nextSteps: string | null;
  doNotRepeat: string | null;
  acceptanceCriteria: string | null;
  createdByModelId: string | null;
  createdAt: string;
}

function rowToCheckpoint(r: CheckpointRow): Checkpoint {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    goal: r.goal,
    completedSummary: r.completed_summary,
    currentContext: r.current_context,
    decisions: r.decisions,
    failedAttempts: r.failed_attempts,
    blockers: r.blockers,
    nextSteps: r.next_steps,
    doNotRepeat: r.do_not_repeat,
    acceptanceCriteria: r.acceptance_criteria,
    createdByModelId: r.created_by_model_id,
    createdAt: r.created_at,
  };
}

export interface CreateCheckpointInput {
  projectId: string;
  title: string;
  goal?: string | null;
  completedSummary?: string | null;
  currentContext?: string | null;
  decisions?: string | null;
  failedAttempts?: string | null;
  blockers?: string | null;
  nextSteps?: string | null;
  doNotRepeat?: string | null;
  acceptanceCriteria?: string | null;
  createdByModelId?: string | null;
}

export const checkpoints = {
  async listByProject(projectId: string): Promise<Checkpoint[]> {
    const db = await getDb();
    const rows = await db.select<CheckpointRow[]>(
      "SELECT * FROM checkpoints WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    return rows.map(rowToCheckpoint);
  },

  async getById(id: string): Promise<Checkpoint | null> {
    const db = await getDb();
    const rows = await db.select<CheckpointRow[]>(
      "SELECT * FROM checkpoints WHERE id = $1",
      [id]
    );
    return rows[0] ? rowToCheckpoint(rows[0]) : null;
  },

  async create(input: CreateCheckpointInput): Promise<Checkpoint> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO checkpoints
        (id, project_id, title, goal, completed_summary, current_context,
         decisions, failed_attempts, blockers, next_steps, do_not_repeat,
         acceptance_criteria, created_by_model_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        input.projectId,
        input.title,
        input.goal ?? null,
        input.completedSummary ?? null,
        input.currentContext ?? null,
        input.decisions ?? null,
        input.failedAttempts ?? null,
        input.blockers ?? null,
        input.nextSteps ?? null,
        input.doNotRepeat ?? null,
        input.acceptanceCriteria ?? null,
        input.createdByModelId ?? null,
        ts,
      ]
    );
    return (await checkpoints.getById(id))!;
  },

  async update(id: string, input: Partial<CreateCheckpointInput>): Promise<Checkpoint> {
    const db = await getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (input.title !== undefined) { sets.push(`title = $${i++}`); vals.push(input.title); }
    if (input.goal !== undefined) { sets.push(`goal = $${i++}`); vals.push(input.goal); }
    if (input.completedSummary !== undefined) { sets.push(`completed_summary = $${i++}`); vals.push(input.completedSummary); }
    if (input.currentContext !== undefined) { sets.push(`current_context = $${i++}`); vals.push(input.currentContext); }
    if (input.decisions !== undefined) { sets.push(`decisions = $${i++}`); vals.push(input.decisions); }
    if (input.failedAttempts !== undefined) { sets.push(`failed_attempts = $${i++}`); vals.push(input.failedAttempts); }
    if (input.blockers !== undefined) { sets.push(`blockers = $${i++}`); vals.push(input.blockers); }
    if (input.nextSteps !== undefined) { sets.push(`next_steps = $${i++}`); vals.push(input.nextSteps); }
    if (input.doNotRepeat !== undefined) { sets.push(`do_not_repeat = $${i++}`); vals.push(input.doNotRepeat); }
    if (input.acceptanceCriteria !== undefined) { sets.push(`acceptance_criteria = $${i++}`); vals.push(input.acceptanceCriteria); }
    vals.push(id);
    await db.execute(
      `UPDATE checkpoints SET ${sets.join(", ")} WHERE id = $${i}`,
      vals
    );
    return (await checkpoints.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM checkpoints WHERE id = $1", [id]);
  },
};
