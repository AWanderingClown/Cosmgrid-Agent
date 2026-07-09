import type { IntentRouteAction } from "../workflow/semantic-intent-router";
import { getDb } from "./connection";
import { boolToInt, newId, now } from "./utils";

// ============ intentLearning CRUD（v0.10：意图样例 + 用户纠错事件） ============

export interface IntentExampleRow {
  id: string;
  action: IntentRouteAction;
  text: string;
  explanation: string;
  source: "builtin" | "user_correction" | "accepted_decision";
  confidence: number;
  weight: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface StoredIntentExample {
  id: string;
  action: IntentRouteAction;
  text: string;
  explanation: string;
  source: "builtin" | "user_correction" | "accepted_decision";
  confidence: number;
  weight: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntentFeedbackEventRow {
  id: string;
  user_text: string;
  predicted_action: IntentRouteAction;
  corrected_action: IntentRouteAction;
  workflow_state: string | null;
  source: "user_text" | "confirm_choice" | "manual_step" | "cancel_after_auto";
  reason: string | null;
  created_at: string;
}

export interface IntentFeedbackEvent {
  id: string;
  userText: string;
  predictedAction: IntentRouteAction;
  correctedAction: IntentRouteAction;
  workflowState: string | null;
  source: "user_text" | "confirm_choice" | "manual_step" | "cancel_after_auto";
  reason: string | null;
  createdAt: string;
}

function mapIntentExampleRow(r: IntentExampleRow): StoredIntentExample {
  return {
    id: r.id,
    action: r.action,
    text: r.text,
    explanation: r.explanation,
    source: r.source,
    confidence: Number(r.confidence),
    weight: Number(r.weight),
    enabled: Boolean(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapIntentFeedbackEventRow(r: IntentFeedbackEventRow): IntentFeedbackEvent {
  return {
    id: r.id,
    userText: r.user_text,
    predictedAction: r.predicted_action,
    correctedAction: r.corrected_action,
    workflowState: r.workflow_state,
    source: r.source,
    reason: r.reason,
    createdAt: r.created_at,
  };
}

export const intentLearning = {
  async upsertExample(input: {
    action: IntentRouteAction;
    text: string;
    explanation: string;
    source: "builtin" | "user_correction" | "accepted_decision";
    confidence?: number;
    weight?: number;
    enabled?: boolean;
  }): Promise<StoredIntentExample> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    const confidence = input.confidence ?? 0.8;
    const weight = input.weight ?? 1;
    const enabled = input.enabled ?? true;
    await db.execute(
      `INSERT INTO intent_examples
        (id, action, text, explanation, source, confidence, weight, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(action, text)
       DO UPDATE SET
         explanation = excluded.explanation,
         source = excluded.source,
         confidence = excluded.confidence,
         weight = excluded.weight,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [
        id,
        input.action,
        input.text,
        input.explanation,
        input.source,
        confidence,
        weight,
        boolToInt(enabled),
        ts,
        ts,
      ],
    );
    const rows = await db.select<IntentExampleRow[]>(
      "SELECT * FROM intent_examples WHERE action = $1 AND text = $2 LIMIT 1",
      [input.action, input.text],
    );
    return mapIntentExampleRow(rows[0]!);
  },

  async listExamples(options: { enabledOnly?: boolean } = {}): Promise<StoredIntentExample[]> {
    const db = await getDb();
    const rows = await db.select<IntentExampleRow[]>(
      options.enabledOnly
        ? "SELECT * FROM intent_examples WHERE enabled = 1 ORDER BY updated_at DESC"
        : "SELECT * FROM intent_examples ORDER BY updated_at DESC",
    );
    return rows.map(mapIntentExampleRow);
  },

  async recordFeedback(input: {
    userText: string;
    predictedAction: IntentRouteAction;
    correctedAction: IntentRouteAction;
    workflowState?: string | null;
    source: "user_text" | "confirm_choice" | "manual_step" | "cancel_after_auto";
    reason?: string | null;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO intent_feedback_events
        (id, user_text, predicted_action, corrected_action, workflow_state, source, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.userText,
        input.predictedAction,
        input.correctedAction,
        input.workflowState ?? null,
        input.source,
        input.reason ?? null,
        now(),
      ],
    );
    return id;
  },

  async listFeedbackEvents(): Promise<IntentFeedbackEvent[]> {
    const db = await getDb();
    const rows = await db.select<IntentFeedbackEventRow[]>(
      "SELECT * FROM intent_feedback_events ORDER BY created_at DESC",
    );
    return rows.map(mapIntentFeedbackEventRow);
  },

  // 2026-07-04 补：阶段3自我成长闭环的"降权"这一半（此前只有"纠正后加权"）。
  // 误判降权（导致一次错误判断的样例，权重打折）+ 长期不用衰减两条路径共用这两个方法。
  async updateExampleWeight(id: string, weight: number): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE intent_examples SET weight = $1, updated_at = $2 WHERE id = $3",
      [weight, now(), id],
    );
  },

  async setExampleEnabled(id: string, enabled: boolean): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE intent_examples SET enabled = $1, updated_at = $2 WHERE id = $3",
      [boolToInt(enabled), now(), id],
    );
  },
};
