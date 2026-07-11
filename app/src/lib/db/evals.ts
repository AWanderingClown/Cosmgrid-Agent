// Harness 工程实施计划 阶段4 — Eval Harness 4 张新表的 DAO。
//
// 4 张表：
// - harness_eval_cases：评估用例定义（fixture 路径 + 权限 + 模型 + 验收标准 + 预算）
// - harness_eval_runs：一次评估运行（harness_version + model_id + cost + status）
// - harness_eval_results：单条用例结果（task × attempt 粒度）
// - task_outcomes：生产任务的最终结果（passed/failed/blocked/needs_user/cancelled）
//
// 设计原则：
// - `harnessVersion` 必填（git sha），否则"修复了什么"对比无锚点
// - `passed` 字段在 eval_results 是 nullable（null = inconclusive，LLM judge 失败 / 抛错）
// - task_outcomes 不通过 FK 强耦合到 conversations（conversation 删除时级联）

import { getDb } from "./connection";
import { newId, now } from "./utils";

export interface EvalCaseRow {
  id: string;
  taskSetId: string;
  name: string;
  fixturePath: string;
  permissionProfile: string;
  allowedModels: string[];
  acceptanceCriteria: string[];
  budgetUsd: number;
  timeoutSeconds: number;
  tags: string[];
  createdAt: string;
}

function mapEvalCaseRow(r: any): EvalCaseRow {
  return {
    id: r.id,
    taskSetId: r.task_set_id,
    name: r.name,
    fixturePath: r.fixture_path,
    permissionProfile: r.permission_profile,
    allowedModels: safeParseJsonArray(r.allowed_models),
    acceptanceCriteria: safeParseJsonArray(r.acceptance_criteria),
    budgetUsd: r.budget_usd,
    timeoutSeconds: r.timeout_seconds,
    tags: safeParseJsonArray(r.tags),
    createdAt: r.created_at,
  };
}

function safeParseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const evalCases = {
  async create(input: Omit<EvalCaseRow, "id" | "createdAt">): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO harness_eval_cases
        (id, task_set_id, name, fixture_path, permission_profile, allowed_models, acceptance_criteria, budget_usd, timeout_seconds, tags, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, input.taskSetId, input.name, input.fixturePath, input.permissionProfile,
        JSON.stringify(input.allowedModels), JSON.stringify(input.acceptanceCriteria),
        input.budgetUsd, input.timeoutSeconds, JSON.stringify(input.tags), now(),
      ],
    );
    return id;
  },

  async listByTaskSet(taskSetId: string): Promise<EvalCaseRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM harness_eval_cases WHERE task_set_id = $1 ORDER BY created_at ASC",
      [taskSetId],
    );
    return rows.map(mapEvalCaseRow);
  },

  async getById(id: string): Promise<EvalCaseRow | null> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM harness_eval_cases WHERE id = $1 LIMIT 1",
      [id],
    );
    return rows.length > 0 ? mapEvalCaseRow(rows[0]) : null;
  },
};

// =====================================================================
// eval_runs
// =====================================================================

export interface EvalRunRow {
  id: string;
  harnessVersion: string;
  modelId: string;
  taskSetId: string;
  startedAt: string;
  finishedAt: string | null;
  totalCostUsd: number;
  retryCount: number;
  status: "running" | "completed" | "aborted" | "timeout";
  artifactJson: string | null;
  failureKindsJson: string | null;
  createdAt: string;
}

function mapEvalRunRow(r: any): EvalRunRow {
  return {
    id: r.id,
    harnessVersion: r.harness_version,
    modelId: r.model_id,
    taskSetId: r.task_set_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    totalCostUsd: r.total_cost_usd,
    retryCount: r.retry_count,
    status: r.status,
    artifactJson: r.artifact_json,
    failureKindsJson: r.failure_kinds_json,
    createdAt: r.created_at,
  };
}

export const evalRuns = {
  async create(input: Omit<EvalRunRow, "id" | "createdAt">): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO harness_eval_runs
        (id, harness_version, model_id, task_set_id, started_at, finished_at, total_cost_usd, retry_count, status, artifact_json, failure_kinds_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id, input.harnessVersion, input.modelId, input.taskSetId, input.startedAt, input.finishedAt,
        input.totalCostUsd, input.retryCount, input.status, input.artifactJson, input.failureKindsJson,
        now(),
      ],
    );
    return id;
  },

  async finish(
    runId: string,
    patch: { finishedAt: string; totalCostUsd: number; retryCount: number; status: EvalRunRow["status"]; failureKindsJson?: string | null },
  ): Promise<void> {
    const db = await getDb();
    await db.execute(
      `UPDATE harness_eval_runs
       SET finished_at = $1, total_cost_usd = $2, retry_count = $3, status = $4, failure_kinds_json = $5
       WHERE id = $6`,
      [patch.finishedAt, patch.totalCostUsd, patch.retryCount, patch.status, patch.failureKindsJson ?? null, runId],
    );
  },

  async listByTaskSet(taskSetId: string, limit = 20): Promise<EvalRunRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM harness_eval_runs WHERE task_set_id = $1 ORDER BY started_at DESC LIMIT $2",
      [taskSetId, limit],
    );
    return rows.map(mapEvalRunRow);
  },

  async latestForTaskSet(taskSetId: string): Promise<EvalRunRow | null> {
    const rows = await this.listByTaskSet(taskSetId, 1);
    return rows[0] ?? null;
  },

  async listByHarnessVersion(harnessVersion: string, limit = 5): Promise<EvalRunRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM harness_eval_runs WHERE harness_version = $1 ORDER BY started_at DESC LIMIT $2",
      [harnessVersion, limit],
    );
    return rows.map(mapEvalRunRow);
  },

  async getById(id: string): Promise<EvalRunRow | null> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM harness_eval_runs WHERE id = $1 LIMIT 1",
      [id],
    );
    return rows.length > 0 ? mapEvalRunRow(rows[0]) : null;
  },
};

// =====================================================================
// eval_results
// =====================================================================

export interface EvalResultRow {
  id: string;
  runId: string;
  taskId: string;
  attemptIndex: number;
  /** null = inconclusive（LLM judge 失败 / 抛错） */
  passed: boolean | null;
  attemptCostUsd: number;
  attemptLatencyMs: number;
  interventionsCount: number;
  failureCode: string | null;
  gradedJson: string | null;
  createdAt: string;
}

function mapEvalResultRow(r: any): EvalResultRow {
  return {
    id: r.id,
    runId: r.run_id,
    taskId: r.task_id,
    attemptIndex: r.attempt_index,
    passed: r.passed === null ? null : !!r.passed,
    attemptCostUsd: r.attempt_cost_usd,
    attemptLatencyMs: r.attempt_latency_ms,
    interventionsCount: r.interventions_count,
    failureCode: r.failure_code,
    gradedJson: r.graded_json,
    createdAt: r.created_at,
  };
}

export const evalResults = {
  async create(input: Omit<EvalResultRow, "id" | "createdAt">): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO harness_eval_results
        (id, run_id, task_id, attempt_index, passed, attempt_cost_usd, attempt_latency_ms, interventions_count, failure_code, graded_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, input.runId, input.taskId, input.attemptIndex,
        input.passed === null ? null : input.passed ? 1 : 0,
        input.attemptCostUsd, input.attemptLatencyMs, input.interventionsCount,
        input.failureCode, input.gradedJson, now(),
      ],
    );
    return id;
  },

  async listByRun(runId: string): Promise<EvalResultRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM harness_eval_results WHERE run_id = $1 ORDER BY task_id, attempt_index",
      [runId],
    );
    return rows.map(mapEvalResultRow);
  },
};

// =====================================================================
// task_outcomes
// =====================================================================

export type TaskOutcomeValue =
  | "passed"
  | "failed"
  | "blocked"
  | "needs_user"
  | "retryable"
  | "cancelled";

export interface TaskOutcomeRow {
  id: string;
  conversationId: string;
  nodeId: string | null;
  outcome: TaskOutcomeValue;
  finalSummary: string | null;
  interventionKind: string | null;
  evidenceRefsJson: string | null;
  createdAt: string;
}

function mapTaskOutcomeRow(r: any): TaskOutcomeRow {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    nodeId: r.node_id,
    outcome: r.outcome,
    finalSummary: r.final_summary,
    interventionKind: r.intervention_kind,
    evidenceRefsJson: r.evidence_refs_json,
    createdAt: r.created_at,
  };
}

export const taskOutcomes = {
  async create(input: Omit<TaskOutcomeRow, "id" | "createdAt">): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO task_outcomes
        (id, conversation_id, node_id, outcome, final_summary, intervention_kind, evidence_refs_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id, input.conversationId, input.nodeId, input.outcome, input.finalSummary,
        input.interventionKind, input.evidenceRefsJson, now(),
      ],
    );
    return id;
  },

  async listByConversation(conversationId: string, limit = 50): Promise<TaskOutcomeRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM task_outcomes WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2",
      [conversationId, limit],
    );
    return rows.map(mapTaskOutcomeRow);
  },

  async countByOutcome(sinceIso: string): Promise<Record<TaskOutcomeValue, number>> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT outcome, COUNT(*) as cnt FROM task_outcomes WHERE created_at >= $1 GROUP BY outcome",
      [sinceIso],
    );
    const out: Record<TaskOutcomeValue, number> = {
      passed: 0, failed: 0, blocked: 0, needs_user: 0, retryable: 0, cancelled: 0,
    };
    for (const r of rows) out[r.outcome as TaskOutcomeValue] = r.cnt;
    return out;
  },
};