import { getDb } from "./connection";
import { boolToInt, newId, now } from "./utils";

export interface Provider {
  id: string;
  name: string;
  type: string;
  website: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiCredential {
  id: string;
  providerId: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  supportsStreaming: boolean;
  supportsFunctionCall: boolean;
  supportsVision: boolean;
  defaultModelId: string | null;
  createdAt: string;
  updatedAt: string;
  provider?: { name: string; type: string };
}

export interface Model {
  id: string;
  providerId: string;
  name: string;
  displayName: string | null;
  contextWindow: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  capabilityTags: string | null;
  capabilityScore: string | null;
  workRoles: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  provider?: { name: string; type: string };
}

interface ProviderRow {
  id: string;
  name: string;
  type: string;
  website: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface CredentialRow {
  id: string;
  provider_id: string;
  name: string;
  base_url: string;
  enabled: number;
  supports_streaming: number;
  supports_function_call: number;
  supports_vision: number;
  default_model_id: string | null;
  created_at: string;
  updated_at: string;
  provider_name?: string;
  provider_type?: string;
}

interface ModelRow {
  id: string;
  provider_id: string;
  name: string;
  display_name: string | null;
  context_window: number | null;
  input_price: number | null;
  output_price: number | null;
  capability_tags: string | null;
  capability_score: string | null;
  work_roles: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  provider_name?: string;
  provider_type?: string;
}

function rowToProvider(r: ProviderRow): Provider {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    website: r.website,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToCredential(r: CredentialRow): ApiCredential {
  return {
    id: r.id,
    providerId: r.provider_id,
    name: r.name,
    baseUrl: r.base_url,
    enabled: r.enabled === 1,
    supportsStreaming: r.supports_streaming === 1,
    supportsFunctionCall: r.supports_function_call === 1,
    supportsVision: r.supports_vision === 1,
    defaultModelId: r.default_model_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.provider_name !== undefined && {
      provider: { name: r.provider_name, type: r.provider_type ?? "" },
    }),
  };
}

function rowToModel(r: ModelRow): Model {
  return {
    id: r.id,
    providerId: r.provider_id,
    name: r.name,
    displayName: r.display_name,
    contextWindow: r.context_window,
    inputPrice: r.input_price,
    outputPrice: r.output_price,
    capabilityTags: r.capability_tags,
    capabilityScore: r.capability_score,
    workRoles: r.work_roles,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.provider_name !== undefined && {
      provider: { name: r.provider_name, type: r.provider_type ?? "" },
    }),
  };
}

export interface CreateProviderInput {
  name: string;
  type: string;
  website?: string | null;
  notes?: string | null;
}

export const providers = {
  async list(): Promise<Provider[]> {
    const db = await getDb();
    const rows = await db.select<ProviderRow[]>(
      "SELECT * FROM providers ORDER BY created_at DESC",
    );
    return rows.map(rowToProvider);
  },

  async getById(id: string): Promise<Provider | null> {
    const db = await getDb();
    const rows = await db.select<ProviderRow[]>(
      "SELECT * FROM providers WHERE id = $1",
      [id],
    );
    return rows[0] ? rowToProvider(rows[0]) : null;
  },

  async create(input: CreateProviderInput): Promise<Provider> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO providers (id, name, type, website, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, input.name, input.type, input.website ?? null, input.notes ?? null, ts, ts],
    );
    return (await providers.getById(id))!;
  },

  async update(id: string, input: Partial<CreateProviderInput>): Promise<Provider> {
    const db = await getDb();
    const ts = now();
    const sets: string[] = ["updated_at = $1"];
    const vals: unknown[] = [ts];
    let i = 2;
    if (input.name !== undefined) { sets.push(`name = $${i++}`); vals.push(input.name); }
    if (input.type !== undefined) { sets.push(`type = $${i++}`); vals.push(input.type); }
    if (input.website !== undefined) { sets.push(`website = $${i++}`); vals.push(input.website); }
    if (input.notes !== undefined) { sets.push(`notes = $${i++}`); vals.push(input.notes); }
    vals.push(id);
    await db.execute(
      `UPDATE providers SET ${sets.join(", ")} WHERE id = $${i}`,
      vals,
    );
    return (await providers.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM providers WHERE id = $1", [id]);
  },
};

export interface CreateCredentialInput {
  providerId: string;
  name: string;
  baseUrl: string;
  enabled?: boolean;
  supportsStreaming?: boolean;
  supportsFunctionCall?: boolean;
  supportsVision?: boolean;
  defaultModelId?: string | null;
}

export const apiCredentials = {
  async list(): Promise<ApiCredential[]> {
    const db = await getDb();
    const rows = await db.select<CredentialRow[]>(`
      SELECT c.*, p.name AS provider_name, p.type AS provider_type
      FROM api_credentials c
      LEFT JOIN providers p ON c.provider_id = p.id
      ORDER BY c.created_at DESC
    `);
    return rows.map(rowToCredential);
  },

  async getById(id: string): Promise<ApiCredential | null> {
    const db = await getDb();
    const rows = await db.select<CredentialRow[]>(
      `SELECT c.*, p.name AS provider_name, p.type AS provider_type
       FROM api_credentials c
       LEFT JOIN providers p ON c.provider_id = p.id
       WHERE c.id = $1`,
      [id],
    );
    return rows[0] ? rowToCredential(rows[0]) : null;
  },

  async create(input: CreateCredentialInput): Promise<ApiCredential> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO api_credentials
        (id, provider_id, name, base_url, enabled, supports_streaming,
         supports_function_call, supports_vision, default_model_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        input.providerId,
        input.name,
        input.baseUrl,
        boolToInt(input.enabled ?? true),
        boolToInt(input.supportsStreaming ?? true),
        boolToInt(input.supportsFunctionCall ?? true),
        boolToInt(input.supportsVision ?? false),
        input.defaultModelId ?? null,
        ts,
        ts,
      ],
    );
    return (await apiCredentials.getById(id))!;
  },

  async update(id: string, input: Partial<CreateCredentialInput>): Promise<ApiCredential> {
    const db = await getDb();
    const ts = now();
    const sets: string[] = ["updated_at = $1"];
    const vals: unknown[] = [ts];
    let i = 2;
    if (input.name !== undefined) { sets.push(`name = $${i++}`); vals.push(input.name); }
    if (input.baseUrl !== undefined) { sets.push(`base_url = $${i++}`); vals.push(input.baseUrl); }
    if (input.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(boolToInt(input.enabled)); }
    if (input.defaultModelId !== undefined) { sets.push(`default_model_id = $${i++}`); vals.push(input.defaultModelId); }
    vals.push(id);
    await db.execute(
      `UPDATE api_credentials SET ${sets.join(", ")} WHERE id = $${i}`,
      vals,
    );
    return (await apiCredentials.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM api_credentials WHERE id = $1", [id]);
  },
};

export interface CreateModelInput {
  providerId: string;
  name: string;
  displayName?: string | null;
  contextWindow?: number | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
  capabilityTags?: string | null;
  capabilityScore?: string | null;
  workRoles: string;
  enabled?: boolean;
}

export const models = {
  async list(): Promise<Model[]> {
    const db = await getDb();
    const rows = await db.select<ModelRow[]>(`
      SELECT m.*, p.name AS provider_name, p.type AS provider_type
      FROM models m
      LEFT JOIN providers p ON m.provider_id = p.id
      ORDER BY m.created_at DESC
    `);
    return rows.map(rowToModel);
  },

  async listEnabled(): Promise<Model[]> {
    const db = await getDb();
    const rows = await db.select<ModelRow[]>(`
      SELECT m.*, p.name AS provider_name, p.type AS provider_type
      FROM models m
      LEFT JOIN providers p ON m.provider_id = p.id
      WHERE m.enabled = 1
      ORDER BY m.created_at DESC
    `);
    return rows.map(rowToModel);
  },

  async getById(id: string): Promise<Model | null> {
    const db = await getDb();
    const rows = await db.select<ModelRow[]>(
      "SELECT * FROM models WHERE id = $1",
      [id],
    );
    return rows[0] ? rowToModel(rows[0]) : null;
  },

  async create(input: CreateModelInput): Promise<Model> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO models
        (id, provider_id, name, display_name, context_window, input_price, output_price,
         capability_tags, capability_score, work_roles, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        input.providerId,
        input.name,
        input.displayName ?? null,
        input.contextWindow ?? null,
        input.inputPrice ?? null,
        input.outputPrice ?? null,
        input.capabilityTags ?? null,
        input.capabilityScore ?? null,
        input.workRoles,
        boolToInt(input.enabled ?? true),
        ts,
        ts,
      ],
    );
    return (await models.getById(id))!;
  },

  async update(id: string, input: Partial<CreateModelInput>): Promise<Model> {
    const db = await getDb();
    const ts = now();
    const sets: string[] = ["updated_at = $1"];
    const vals: unknown[] = [ts];
    let i = 2;
    if (input.name !== undefined) { sets.push(`name = $${i++}`); vals.push(input.name); }
    if (input.displayName !== undefined) { sets.push(`display_name = $${i++}`); vals.push(input.displayName); }
    if (input.contextWindow !== undefined) { sets.push(`context_window = $${i++}`); vals.push(input.contextWindow); }
    if (input.inputPrice !== undefined) { sets.push(`input_price = $${i++}`); vals.push(input.inputPrice); }
    if (input.outputPrice !== undefined) { sets.push(`output_price = $${i++}`); vals.push(input.outputPrice); }
    if (input.capabilityTags !== undefined) { sets.push(`capability_tags = $${i++}`); vals.push(input.capabilityTags); }
    if (input.capabilityScore !== undefined) { sets.push(`capability_score = $${i++}`); vals.push(input.capabilityScore); }
    if (input.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(boolToInt(input.enabled)); }
    if (input.workRoles !== undefined) { sets.push(`work_roles = $${i++}`); vals.push(input.workRoles); }
    vals.push(id);
    await db.execute(
      `UPDATE models SET ${sets.join(", ")} WHERE id = $${i}`,
      vals,
    );
    return (await models.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM models WHERE id = $1", [id]);
  },
};
