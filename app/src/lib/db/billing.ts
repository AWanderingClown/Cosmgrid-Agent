import { getDb } from "./connection";
import { boolToInt, newId, now } from "./utils";

// ============ model_price_catalog CRUD ============

export interface ModelPriceCatalogEntry {
  id: string;
  modelName: string;
  providerType: string | null;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number | null;
  cacheWritePer1m: number | null;
  contextWindow: number | null;
  source: "builtin" | "remote" | "manual";
  sourceUrl: string | null;
  version: string;
  enabled: boolean;
  updatedAt: string;
}

export interface ModelPriceCatalogVersion {
  source: "builtin" | "remote" | "manual";
  version: string;
  entryCount: number;
  enabledCount: number;
  firstUpdatedAt: string;
  lastUpdatedAt: string;
}

interface ModelPriceCatalogRow {
  id: string;
  model_name: string;
  provider_type: string | null;
  input_per_1m: number;
  output_per_1m: number;
  cache_read_per_1m: number | null;
  cache_write_per_1m: number | null;
  context_window: number | null;
  source: "builtin" | "remote" | "manual";
  source_url: string | null;
  version: string;
  enabled: number;
  updated_at: string;
}

interface ModelPriceCatalogVersionRow {
  source: "builtin" | "remote" | "manual";
  version: string;
  entry_count: number;
  enabled_count: number;
  first_updated_at: string;
  last_updated_at: string;
}

function rowToModelPriceCatalogEntry(r: ModelPriceCatalogRow): ModelPriceCatalogEntry {
  return {
    id: r.id,
    modelName: r.model_name,
    providerType: r.provider_type,
    inputPer1m: r.input_per_1m,
    outputPer1m: r.output_per_1m,
    cacheReadPer1m: r.cache_read_per_1m,
    cacheWritePer1m: r.cache_write_per_1m,
    contextWindow: r.context_window,
    source: r.source,
    sourceUrl: r.source_url,
    version: r.version,
    enabled: r.enabled === 1,
    updatedAt: r.updated_at,
  };
}

function rowToModelPriceCatalogVersion(r: ModelPriceCatalogVersionRow): ModelPriceCatalogVersion {
  return {
    source: r.source,
    version: r.version,
    entryCount: r.entry_count,
    enabledCount: r.enabled_count,
    firstUpdatedAt: r.first_updated_at,
    lastUpdatedAt: r.last_updated_at,
  };
}

export const modelPriceCatalog = {
  async create(input: {
    modelName: string;
    providerType?: string | null;
    inputPer1m: number;
    outputPer1m: number;
    cacheReadPer1m?: number | null;
    cacheWritePer1m?: number | null;
    contextWindow?: number | null;
    source: "builtin" | "remote" | "manual";
    sourceUrl?: string | null;
    version: string;
    enabled?: boolean;
  }): Promise<ModelPriceCatalogEntry> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO model_price_catalog
        (id, model_name, provider_type, input_per_1m, output_per_1m,
         cache_read_per_1m, cache_write_per_1m, context_window,
         source, source_url, version, enabled, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        input.modelName,
        input.providerType ?? null,
        input.inputPer1m,
        input.outputPer1m,
        input.cacheReadPer1m ?? null,
        input.cacheWritePer1m ?? null,
        input.contextWindow ?? null,
        input.source,
        input.sourceUrl ?? null,
        input.version,
        boolToInt(input.enabled ?? true),
        ts,
      ],
    );
    const row = await this.getById(id);
    if (!row) throw new Error(`price catalog row ${id} not found after create`);
    return row;
  },

  async getById(id: string): Promise<ModelPriceCatalogEntry | null> {
    const db = await getDb();
    const rows = await db.select<ModelPriceCatalogRow[]>(
      "SELECT * FROM model_price_catalog WHERE id = $1 LIMIT 1",
      [id],
    );
    return rows[0] ? rowToModelPriceCatalogEntry(rows[0]) : null;
  },

  async list(): Promise<ModelPriceCatalogEntry[]> {
    const db = await getDb();
    const rows = await db.select<ModelPriceCatalogRow[]>(
      "SELECT * FROM model_price_catalog ORDER BY updated_at DESC, model_name ASC",
    );
    return rows.map(rowToModelPriceCatalogEntry);
  },

  async listActive(): Promise<ModelPriceCatalogEntry[]> {
    const db = await getDb();
    const rows = await db.select<ModelPriceCatalogRow[]>(
      "SELECT * FROM model_price_catalog WHERE enabled = 1 ORDER BY updated_at DESC, model_name ASC",
    );
    return rows.map(rowToModelPriceCatalogEntry);
  },

  async listVersions(): Promise<ModelPriceCatalogVersion[]> {
    const db = await getDb();
    const rows = await db.select<ModelPriceCatalogVersionRow[]>(
      `SELECT
         source,
         version,
         COUNT(*) AS entry_count,
         SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled_count,
         MIN(updated_at) AS first_updated_at,
         MAX(updated_at) AS last_updated_at
       FROM model_price_catalog
       GROUP BY source, version
       ORDER BY enabled_count DESC, last_updated_at DESC, source ASC, version DESC`,
    );
    return rows.map(rowToModelPriceCatalogVersion);
  },

  async lookupActive(
    modelName: string,
    providerType?: string | null,
  ): Promise<ModelPriceCatalogEntry | null> {
    const db = await getDb();
    const rows = await db.select<ModelPriceCatalogRow[]>(
      `SELECT * FROM model_price_catalog
       WHERE enabled = 1
         AND lower(model_name) = lower($1)
         AND ($2 IS NULL OR provider_type = $2 OR provider_type IS NULL)
       ORDER BY
         CASE source WHEN 'manual' THEN 0 WHEN 'remote' THEN 1 ELSE 2 END,
         CASE WHEN provider_type = $2 THEN 0 WHEN provider_type IS NULL THEN 1 ELSE 2 END,
         updated_at DESC
       LIMIT 1`,
      [modelName, providerType ?? null],
    );
    return rows[0] ? rowToModelPriceCatalogEntry(rows[0]) : null;
  },

  async disableSource(source: "builtin" | "remote" | "manual"): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE model_price_catalog SET enabled = 0 WHERE source = $1", [source]);
  },

  async disableManualForModel(modelName: string, providerType?: string | null): Promise<void> {
    const db = await getDb();
    await db.execute(
      `UPDATE model_price_catalog
       SET enabled = 0
       WHERE source = 'manual'
         AND lower(model_name) = lower($1)
         AND (($2 IS NULL AND provider_type IS NULL) OR provider_type = $2)`,
      [modelName, providerType ?? null],
    );
  },

  async replaceSourceEntries(
    source: "builtin" | "remote" | "manual",
    entries: Array<{
      modelName: string;
      providerType?: string | null;
      inputPer1m: number;
      outputPer1m: number;
      cacheReadPer1m?: number | null;
      cacheWritePer1m?: number | null;
      contextWindow?: number | null;
      source: "builtin" | "remote" | "manual";
      sourceUrl?: string | null;
      version: string;
      enabled?: boolean;
    }>,
  ): Promise<void> {
    const db = await getDb();
    const ts = now();
    await db.execute("BEGIN TRANSACTION");
    try {
      await db.execute("UPDATE model_price_catalog SET enabled = 0 WHERE source = $1", [source]);
      for (const entry of entries) {
        await db.execute(
          `INSERT INTO model_price_catalog
            (id, model_name, provider_type, input_per_1m, output_per_1m,
             cache_read_per_1m, cache_write_per_1m, context_window,
             source, source_url, version, enabled, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            newId(),
            entry.modelName,
            entry.providerType ?? null,
            entry.inputPer1m,
            entry.outputPer1m,
            entry.cacheReadPer1m ?? null,
            entry.cacheWritePer1m ?? null,
            entry.contextWindow ?? null,
            entry.source,
            entry.sourceUrl ?? null,
            entry.version,
            boolToInt(entry.enabled ?? true),
            ts,
          ],
        );
      }
      await db.execute("COMMIT");
    } catch (error) {
      await db.execute("ROLLBACK").catch(() => {});
      throw error;
    }
  },
};

// ============ price_sync_status CRUD ============

export interface PriceSyncStatus {
  id: string;
  source: string;
  sourceUrl: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  catalogVersion: string | null;
}

interface PriceSyncStatusRow {
  id: string;
  source: string;
  source_url: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  catalog_version: string | null;
}

function rowToPriceSyncStatus(r: PriceSyncStatusRow): PriceSyncStatus {
  return {
    id: r.id,
    source: r.source,
    sourceUrl: r.source_url,
    lastAttemptAt: r.last_attempt_at,
    lastSuccessAt: r.last_success_at,
    lastError: r.last_error,
    catalogVersion: r.catalog_version,
  };
}

export const priceSyncStatus = {
  async get(id = "global"): Promise<PriceSyncStatus | null> {
    const db = await getDb();
    const rows = await db.select<PriceSyncStatusRow[]>(
      "SELECT * FROM price_sync_status WHERE id = $1 LIMIT 1",
      [id],
    );
    return rows[0] ? rowToPriceSyncStatus(rows[0]) : null;
  },

  async upsert(input: {
    id?: string;
    source: string;
    sourceUrl?: string | null;
    lastAttemptAt?: string | null;
    lastSuccessAt?: string | null;
    lastError?: string | null;
    catalogVersion?: string | null;
  }): Promise<PriceSyncStatus> {
    const db = await getDb();
    const id = input.id ?? "global";
    await db.execute(
      `INSERT INTO price_sync_status
        (id, source, source_url, last_attempt_at, last_success_at, last_error, catalog_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(id) DO UPDATE SET
         source = excluded.source,
         source_url = excluded.source_url,
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = excluded.last_success_at,
         last_error = excluded.last_error,
         catalog_version = excluded.catalog_version`,
      [
        id,
        input.source,
        input.sourceUrl ?? null,
        input.lastAttemptAt ?? null,
        input.lastSuccessAt ?? null,
        input.lastError ?? null,
        input.catalogVersion ?? null,
      ],
    );
    return (await this.get(id))!;
  },
};

// ============ savings_events CRUD ============

export interface SavingsEventRow {
  id: string;
  usageEventId: string | null;
  conversationId: string | null;
  projectId: string | null;
  kind: "cache" | "routing" | "compression";
  baselineModelId: string | null;
  actualModelId: string | null;
  baselineCost: number;
  actualCost: number;
  savedCost: number;
  currency: string;
  formulaVersion: string;
  explainJson: string;
  actualPriceCatalogId: string | null;
  baselinePriceCatalogId: string | null;
  createdAt: string;
}

export interface SavingsEventSummary {
  eventCount: number;
  totalSavedCost: number;
  traceableEventCount: number;
  missingPriceCatalogEventCount: number;
  byKind: Array<{
    kind: "cache" | "routing" | "compression";
    eventCount: number;
    totalSavedCost: number;
  }>;
}

interface SavingsEventDbRow {
  id: string;
  usage_event_id: string | null;
  conversation_id: string | null;
  project_id: string | null;
  kind: "cache" | "routing" | "compression";
  baseline_model_id: string | null;
  actual_model_id: string | null;
  baseline_cost: number;
  actual_cost: number;
  saved_cost: number;
  currency: string;
  formula_version: string;
  explain_json: string;
  actual_price_catalog_id: string | null;
  baseline_price_catalog_id: string | null;
  created_at: string;
}

function rowToSavingsEvent(r: SavingsEventDbRow): SavingsEventRow {
  return {
    id: r.id,
    usageEventId: r.usage_event_id,
    conversationId: r.conversation_id,
    projectId: r.project_id,
    kind: r.kind,
    baselineModelId: r.baseline_model_id,
    actualModelId: r.actual_model_id,
    baselineCost: r.baseline_cost,
    actualCost: r.actual_cost,
    savedCost: r.saved_cost,
    currency: r.currency,
    formulaVersion: r.formula_version,
    explainJson: r.explain_json,
    actualPriceCatalogId: r.actual_price_catalog_id ?? null,
    baselinePriceCatalogId: r.baseline_price_catalog_id ?? null,
    createdAt: r.created_at,
  };
}

export const savingsEvents = {
  async create(input: {
    usageEventId?: string | null;
    conversationId?: string | null;
    projectId?: string | null;
    kind: "cache" | "routing" | "compression";
    baselineModelId?: string | null;
    actualModelId?: string | null;
    baselineCost: number;
    actualCost: number;
    savedCost: number;
    currency?: string;
    formulaVersion: string;
    explainJson: string;
    actualPriceCatalogId?: string | null;
    baselinePriceCatalogId?: string | null;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO savings_events
        (id, usage_event_id, conversation_id, project_id, kind, baseline_model_id, actual_model_id,
         baseline_cost, actual_cost, saved_cost, currency, formula_version, explain_json,
         actual_price_catalog_id, baseline_price_catalog_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        input.usageEventId ?? null,
        input.conversationId ?? null,
        input.projectId ?? null,
        input.kind,
        input.baselineModelId ?? null,
        input.actualModelId ?? null,
        input.baselineCost,
        input.actualCost,
        input.savedCost,
        input.currency ?? "USD",
        input.formulaVersion,
        input.explainJson,
        input.actualPriceCatalogId ?? null,
        input.baselinePriceCatalogId ?? null,
        ts,
      ],
    );
    return id;
  },

  async list(sinceTs?: string): Promise<SavingsEventRow[]> {
    const db = await getDb();
    const rows = sinceTs
      ? await db.select<SavingsEventDbRow[]>(
          "SELECT * FROM savings_events WHERE created_at >= $1 ORDER BY created_at DESC",
          [sinceTs],
        )
      : await db.select<SavingsEventDbRow[]>(
          "SELECT * FROM savings_events ORDER BY created_at DESC",
        );
    return rows.map(rowToSavingsEvent);
  },

  async summary(sinceTs?: string): Promise<SavingsEventSummary> {
    const rows = await this.list(sinceTs);
    const byKind = new Map<"cache" | "routing" | "compression", { eventCount: number; totalSavedCost: number }>();
    let totalSavedCost = 0;
    let traceableEventCount = 0;
    let missingPriceCatalogEventCount = 0;

    for (const row of rows) {
      totalSavedCost += row.savedCost;
      const current = byKind.get(row.kind) ?? { eventCount: 0, totalSavedCost: 0 };
      current.eventCount += 1;
      current.totalSavedCost += row.savedCost;
      byKind.set(row.kind, current);

      if (row.actualPriceCatalogId && row.baselinePriceCatalogId) {
        traceableEventCount += 1;
      } else {
        missingPriceCatalogEventCount += 1;
      }
    }

    return {
      eventCount: rows.length,
      totalSavedCost: Math.round(totalSavedCost * 10_000) / 10_000,
      traceableEventCount,
      missingPriceCatalogEventCount,
      byKind: Array.from(byKind.entries())
        .map(([kind, value]) => ({
          kind,
          eventCount: value.eventCount,
          totalSavedCost: Math.round(value.totalSavedCost * 10_000) / 10_000,
        }))
        .sort((a, b) => b.totalSavedCost - a.totalSavedCost || a.kind.localeCompare(b.kind)),
    };
  },
};

// ============ cli_sessions CRUD ============

export interface CliSessionRow {
  id: string;
  providerType: string;
  conversationId: string | null;
  projectId: string | null;
  officialSessionId: string;
  modelName: string | null;
  program: string | null;
  status: "active" | "completed" | "failed" | "unknown";
  lastEventAt: string;
  createdAt: string;
}

interface CliSessionDbRow {
  id: string;
  provider_type: string;
  conversation_id: string | null;
  project_id: string | null;
  official_session_id: string;
  model_name: string | null;
  program: string | null;
  status: "active" | "completed" | "failed" | "unknown";
  last_event_at: string;
  created_at: string;
}

function rowToCliSession(r: CliSessionDbRow): CliSessionRow {
  return {
    id: r.id,
    providerType: r.provider_type,
    conversationId: r.conversation_id,
    projectId: r.project_id,
    officialSessionId: r.official_session_id,
    modelName: r.model_name,
    program: r.program,
    status: r.status,
    lastEventAt: r.last_event_at,
    createdAt: r.created_at,
  };
}

export const cliSessions = {
  async upsert(input: {
    providerType: string;
    conversationId?: string | null;
    projectId?: string | null;
    officialSessionId: string;
    modelName?: string | null;
    program?: string | null;
    status?: "active" | "completed" | "failed" | "unknown";
  }): Promise<CliSessionRow> {
    const db = await getDb();
    const ts = now();
    await db.execute(
      `INSERT INTO cli_sessions
        (id, provider_type, conversation_id, project_id, official_session_id, model_name, program, status, last_event_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(provider_type, official_session_id) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         project_id = excluded.project_id,
         model_name = excluded.model_name,
         program = excluded.program,
         status = excluded.status,
         last_event_at = excluded.last_event_at`,
      [
        newId(),
        input.providerType,
        input.conversationId ?? null,
        input.projectId ?? null,
        input.officialSessionId,
        input.modelName ?? null,
        input.program ?? null,
        input.status ?? "active",
        ts,
        ts,
      ],
    );
    const rows = await db.select<CliSessionDbRow[]>(
      "SELECT * FROM cli_sessions WHERE provider_type = $1 AND official_session_id = $2 LIMIT 1",
      [input.providerType, input.officialSessionId],
    );
    return rowToCliSession(rows[0]!);
  },

  async list(): Promise<CliSessionRow[]> {
    const db = await getDb();
    const rows = await db.select<CliSessionDbRow[]>(
      "SELECT * FROM cli_sessions ORDER BY last_event_at DESC",
    );
    return rows.map(rowToCliSession);
  },
};
