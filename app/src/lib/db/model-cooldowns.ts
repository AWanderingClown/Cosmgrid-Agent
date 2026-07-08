import { getDb } from "./connection";
import { now } from "./utils";

export interface ModelCooldownRow {
  model_id: string;
  failures: number;
  cooldown_until: string | null;
  updated_at: string;
}

export interface ModelCooldown {
  modelId: string;
  failures: number;
  cooldownUntil: string | null;
  updatedAt: string;
}

function mapRow(row: ModelCooldownRow): ModelCooldown {
  return {
    modelId: row.model_id,
    failures: row.failures,
    cooldownUntil: row.cooldown_until,
    updatedAt: row.updated_at,
  };
}

export const modelCooldowns = {
  async listByModelIds(modelIds: readonly string[]): Promise<ModelCooldown[]> {
    const unique = [...new Set(modelIds.filter(Boolean))];
    if (unique.length === 0) return [];
    const placeholders = unique.map((_, index) => `$${index + 1}`).join(",");
    const db = await getDb();
    const rows = await db.select<ModelCooldownRow[]>(
      `SELECT * FROM model_cooldowns WHERE model_id IN (${placeholders})`,
      unique,
    );
    return rows.map(mapRow);
  },

  async upsert(input: {
    modelId: string;
    failures: number;
    cooldownUntil: string | null;
  }): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT INTO model_cooldowns (model_id, failures, cooldown_until, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(model_id) DO UPDATE SET
         failures = excluded.failures,
         cooldown_until = excluded.cooldown_until,
         updated_at = excluded.updated_at`,
      [input.modelId, input.failures, input.cooldownUntil, now()],
    );
  },

  async clear(modelId: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM model_cooldowns WHERE model_id = $1", [modelId]);
  },
};
