import { getDb } from "./connection";
import { boolToInt, newId, now } from "./utils";

// ============ tokenPlans CRUD ============

export interface TokenPlan {
  id: string;
  providerId: string;
  linkedApiCredentialId: string | null;
  name: string;
  planType: string;
  quotaUnit: string;
  totalQuota: number | null;
  usedQuota: number;
  resetRule: string | null;
  nextResetAt: string | null;
  warningThresholds: string | null;
  status: string;
  autoTrackEnabled: boolean;
  manualUpdateRequired: boolean;
  fallbackModelId: string | null;
  createdAt: string;
  updatedAt: string;
  provider?: { name: string };
}

interface TokenPlanRow {
  id: string;
  provider_id: string;
  linked_api_credential_id: string | null;
  name: string;
  plan_type: string;
  quota_unit: string;
  total_quota: number | null;
  used_quota: number;
  reset_rule: string | null;
  next_reset_at: string | null;
  warning_thresholds: string | null;
  status: string;
  auto_track_enabled: number;
  manual_update_required: number;
  fallback_model_id: string | null;
  created_at: string;
  updated_at: string;
  provider_name?: string;
}

function rowToTokenPlan(r: TokenPlanRow): TokenPlan {
  return {
    id: r.id,
    providerId: r.provider_id,
    linkedApiCredentialId: r.linked_api_credential_id,
    name: r.name,
    planType: r.plan_type,
    quotaUnit: r.quota_unit,
    totalQuota: r.total_quota,
    usedQuota: r.used_quota,
    resetRule: r.reset_rule,
    nextResetAt: r.next_reset_at,
    warningThresholds: r.warning_thresholds,
    status: r.status,
    autoTrackEnabled: r.auto_track_enabled === 1,
    manualUpdateRequired: r.manual_update_required === 1,
    fallbackModelId: r.fallback_model_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.provider_name !== undefined && { provider: { name: r.provider_name } }),
  };
}

export interface CreateTokenPlanInput {
  providerId: string;
  linkedApiCredentialId?: string | null;
  name: string;
  planType: string;
  quotaUnit: string;
  totalQuota?: number | null;
  resetRule?: string | null;
  nextResetAt?: string | null;
  warningThresholds?: string | null;
  autoTrackEnabled?: boolean;
  manualUpdateRequired?: boolean;
  fallbackModelId?: string | null;
}

export const tokenPlans = {
  async list(): Promise<TokenPlan[]> {
    const db = await getDb();
    const rows = await db.select<TokenPlanRow[]>(`
      SELECT t.*, p.name AS provider_name
      FROM token_plans t
      LEFT JOIN providers p ON t.provider_id = p.id
      ORDER BY t.created_at DESC
    `);
    return rows.map(rowToTokenPlan);
  },

  async getById(id: string): Promise<TokenPlan | null> {
    const db = await getDb();
    const rows = await db.select<TokenPlanRow[]>(
      "SELECT * FROM token_plans WHERE id = $1",
      [id]
    );
    return rows[0] ? rowToTokenPlan(rows[0]) : null;
  },

  async create(input: CreateTokenPlanInput): Promise<TokenPlan> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO token_plans
        (id, provider_id, linked_api_credential_id, name, plan_type, quota_unit,
         total_quota, used_quota, reset_rule, next_reset_at, warning_thresholds,
         status, auto_track_enabled, manual_update_required, fallback_model_id,
         created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        id,
        input.providerId,
        input.linkedApiCredentialId ?? null,
        input.name,
        input.planType,
        input.quotaUnit,
        input.totalQuota ?? null,
        0,
        input.resetRule ?? null,
        input.nextResetAt ?? null,
        input.warningThresholds ?? null,
        "active",
        boolToInt(input.autoTrackEnabled ?? false),
        boolToInt(input.manualUpdateRequired ?? false),
        input.fallbackModelId ?? null,
        ts,
        ts,
      ]
    );
    return (await tokenPlans.getById(id))!;
  },

  async update(id: string, input: Partial<CreateTokenPlanInput> & { usedQuota?: number; status?: string }): Promise<TokenPlan> {
    const db = await getDb();
    const ts = now();
    const sets: string[] = ["updated_at = $1"];
    const vals: unknown[] = [ts];
    let i = 2;
    if (input.name !== undefined) { sets.push(`name = $${i++}`); vals.push(input.name); }
    if (input.totalQuota !== undefined) { sets.push(`total_quota = $${i++}`); vals.push(input.totalQuota); }
    if (input.usedQuota !== undefined) { sets.push(`used_quota = $${i++}`); vals.push(input.usedQuota); }
    if (input.resetRule !== undefined) { sets.push(`reset_rule = $${i++}`); vals.push(input.resetRule); }
    if (input.nextResetAt !== undefined) { sets.push(`next_reset_at = $${i++}`); vals.push(input.nextResetAt); }
    if (input.warningThresholds !== undefined) { sets.push(`warning_thresholds = $${i++}`); vals.push(input.warningThresholds); }
    if (input.status !== undefined) { sets.push(`status = $${i++}`); vals.push(input.status); }
    if (input.fallbackModelId !== undefined) { sets.push(`fallback_model_id = $${i++}`); vals.push(input.fallbackModelId); }
    vals.push(id);
    await db.execute(
      `UPDATE token_plans SET ${sets.join(", ")} WHERE id = $${i}`,
      vals
    );
    return (await tokenPlans.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM token_plans WHERE id = $1", [id]);
  },
};
