// 数据库层：tauri-plugin-sql 直连 SQLite
// 替代 server/db.ts + server/routes/factory.ts（Prisma + Hono）
// 所有 id 用 crypto.randomUUID()，Boolean 存 INTEGER，DateTime 存 TEXT ISO

import Database from "@tauri-apps/plugin-sql";
import { BUILT_IN_TEMPLATES } from "./templates";

// ============ 单例 ============

let _db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!_db) {
    _db = await Database.load("sqlite:cosmgrid.db");
  }
  return _db;
}

// ============ 工具函数 ============

function now(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

function boolToInt(v: boolean): number {
  return v ? 1 : 0;
}

// ============ 建表 DDL（14 张，IF NOT EXISTS） ============

export async function initSchema(): Promise<void> {
  const db = await getDb();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      website TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS api_credentials (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_streaming INTEGER NOT NULL DEFAULT 1,
      supports_function_call INTEGER NOT NULL DEFAULT 1,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      default_model_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS token_plans (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      linked_api_credential_id TEXT,
      name TEXT NOT NULL,
      plan_type TEXT NOT NULL,
      quota_unit TEXT NOT NULL,
      total_quota REAL,
      used_quota REAL NOT NULL DEFAULT 0,
      reset_rule TEXT,
      next_reset_at TEXT,
      warning_thresholds TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      auto_track_enabled INTEGER NOT NULL DEFAULT 0,
      manual_update_required INTEGER NOT NULL DEFAULT 0,
      fallback_model_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT,
      context_window INTEGER,
      input_price REAL,
      output_price REAL,
      capability_tags TEXT,
      capability_score TEXT,
      work_roles TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      is_built_in INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // 内置模板名称唯一，防止 seedBuiltInTemplates() 并发调用（如 React StrictMode 双触发 effect）插出重复行
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_templates_builtin_name
    ON project_templates(name) WHERE is_built_in = 1
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_template_roles (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      work_role TEXT NOT NULL,
      model_id TEXT NOT NULL,
      fallback_model_id TEXT,
      "order" INTEGER NOT NULL DEFAULT 0,
      system_prompt TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (template_id) REFERENCES project_templates(id) ON DELETE CASCADE,
      UNIQUE (template_id, work_role)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      template_id TEXT,
      current_stage TEXT NOT NULL DEFAULT 'main_chat',
      status TEXT NOT NULL DEFAULT 'pending',
      workspace_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_stages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      work_role TEXT NOT NULL,
      model_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      output_summary TEXT,
      error_message TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      default_model_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_model_snapshots (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      switched_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT,
      completed_summary TEXT,
      current_context TEXT,
      decisions TEXT,
      failed_attempts TEXT,
      blockers TEXT,
      next_steps TEXT,
      do_not_repeat TEXT,
      acceptance_criteria TEXT,
      created_by_model_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS handoff_packets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      target_role TEXT NOT NULL,
      target_model_id TEXT,
      format TEXT NOT NULL DEFAULT 'markdown',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      provider_id TEXT,
      api_credential_id TEXT,
      token_plan_id TEXT,
      model_id TEXT,
      project_id TEXT,
      role TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 1,
      interrupted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  // v0.6 项目级长期记忆（4.11 记忆分层 + 5.6 RAG）
  // 每条记忆 = 一段结构化笔记（决策 / 经验 / 上下文 / 失败教训），
  // 减少重复解释背景；做 RAG 时按 title/content 检索（不引 Embedding 依赖）
  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_memories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 50,
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_project_memories_project
    ON project_memories(project_id, importance DESC)
  `);
}

// ============ 内置模板种子数据（4.13.3，只建模板本体，不建角色——角色模型由用户分配） ============

export async function seedBuiltInTemplates(): Promise<void> {
  const db = await getDb();
  // 用 ON CONFLICT DO NOTHING（基于 idx_project_templates_builtin_name 唯一索引）代替
  // “先查后插”：后者在并发调用下（如 React StrictMode 双触发 effect）会竞态产生重复行。
  for (const tpl of BUILT_IN_TEMPLATES) {
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO project_templates (id, name, description, icon, is_built_in, is_default, created_at, updated_at)
       VALUES ($1,$2,$3,$4,1,0,$5,$6)
       ON CONFLICT(name) WHERE is_built_in = 1 DO NOTHING`,
      [id, tpl.name, tpl.descriptionKey, tpl.icon, ts, ts]
    );
  }
}

// ============ 数据类型 ============

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

// ============ 内部行类型（SQLite 返回的原始格式）============

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

// ============ 行转 camelCase ============

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

// ============ providers CRUD ============

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
      "SELECT * FROM providers ORDER BY created_at DESC"
    );
    return rows.map(rowToProvider);
  },

  async getById(id: string): Promise<Provider | null> {
    const db = await getDb();
    const rows = await db.select<ProviderRow[]>(
      "SELECT * FROM providers WHERE id = $1",
      [id]
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
      [id, input.name, input.type, input.website ?? null, input.notes ?? null, ts, ts]
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
      vals
    );
    return (await providers.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM providers WHERE id = $1", [id]);
  },
};

// ============ apiCredentials CRUD ============

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
      "SELECT * FROM api_credentials WHERE id = $1",
      [id]
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
      ]
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
      vals
    );
    return (await apiCredentials.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM api_credentials WHERE id = $1", [id]);
  },
};

// ============ models CRUD ============

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
      [id]
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
      ]
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
    if (input.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(boolToInt(input.enabled)); }
    if (input.workRoles !== undefined) { sets.push(`work_roles = $${i++}`); vals.push(input.workRoles); }
    vals.push(id);
    await db.execute(
      `UPDATE models SET ${sets.join(", ")} WHERE id = $${i}`,
      vals
    );
    return (await models.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM models WHERE id = $1", [id]);
  },
};

// ============ conversations CRUD ============

export interface ConversationRow {
  id: string;
  project_id: string | null;
  title: string;
  default_model_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  projectId: string | null;
  title: string;
  defaultModelId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  created_at: string;
}

export interface DbMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  createdAt: string;
}

export const conversations = {
  async list(): Promise<Conversation[]> {
    const db = await getDb();
    const rows = await db.select<ConversationRow[]>(
      "SELECT * FROM conversations ORDER BY updated_at DESC"
    );
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      defaultModelId: r.default_model_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  },

  async create(input: { title: string; defaultModelId?: string | null; projectId?: string | null }): Promise<Conversation> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO conversations (id, project_id, title, default_model_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.projectId ?? null, input.title, input.defaultModelId ?? null, ts, ts]
    );
    const rows = await db.select<ConversationRow[]>("SELECT * FROM conversations WHERE id = $1", [id]);
    const r = rows[0]!;
    return { id: r.id, projectId: r.project_id, title: r.title, defaultModelId: r.default_model_id, createdAt: r.created_at, updatedAt: r.updated_at };
  },
};

export const messages = {
  async listByConversation(conversationId: string): Promise<DbMessage[]> {
    const db = await getDb();
    const rows = await db.select<MessageRow[]>(
      "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversationId]
    );
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      modelId: r.model_id,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cost: r.cost,
      createdAt: r.created_at,
    }));
  },

  async create(input: {
    conversationId: string;
    role: string;
    content: string;
    modelId?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
  }): Promise<DbMessage> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO messages
        (id, conversation_id, role, content, model_id, input_tokens, output_tokens, cost, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        input.conversationId,
        input.role,
        input.content,
        input.modelId ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cost ?? 0,
        ts,
      ]
    );
    const rows = await db.select<MessageRow[]>("SELECT * FROM messages WHERE id = $1", [id]);
    const r = rows[0]!;
    return { id: r.id, conversationId: r.conversation_id, role: r.role, content: r.content, modelId: r.model_id, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cost: r.cost, createdAt: r.created_at };
  },
};

// ============ projectTemplates CRUD ============

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  isBuiltIn: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTemplateRole {
  id: string;
  templateId: string;
  workRole: string;
  modelId: string;
  fallbackModelId: string | null;
  order: number;
  systemPrompt: string | null;
  enabled: boolean;
}

interface ProjectTemplateRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  is_built_in: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

interface ProjectTemplateRoleRow {
  id: string;
  template_id: string;
  work_role: string;
  model_id: string;
  fallback_model_id: string | null;
  order: number;
  system_prompt: string | null;
  enabled: number;
}

function rowToProjectTemplate(r: ProjectTemplateRow): ProjectTemplate {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    isBuiltIn: r.is_built_in === 1,
    isDefault: r.is_default === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToProjectTemplateRole(r: ProjectTemplateRoleRow): ProjectTemplateRole {
  return {
    id: r.id,
    templateId: r.template_id,
    workRole: r.work_role,
    modelId: r.model_id,
    fallbackModelId: r.fallback_model_id,
    order: r.order,
    systemPrompt: r.system_prompt,
    enabled: r.enabled === 1,
  };
}

export interface CreateProjectTemplateInput {
  name: string;
  description?: string | null;
  icon?: string | null;
  isBuiltIn?: boolean;
  isDefault?: boolean;
}

export const projectTemplates = {
  async list(): Promise<ProjectTemplate[]> {
    const db = await getDb();
    const rows = await db.select<ProjectTemplateRow[]>(
      "SELECT * FROM project_templates ORDER BY is_built_in DESC, created_at ASC"
    );
    return rows.map(rowToProjectTemplate);
  },

  async getById(id: string): Promise<ProjectTemplate | null> {
    const db = await getDb();
    const rows = await db.select<ProjectTemplateRow[]>(
      "SELECT * FROM project_templates WHERE id = $1",
      [id]
    );
    return rows[0] ? rowToProjectTemplate(rows[0]) : null;
  },

  async create(input: CreateProjectTemplateInput): Promise<ProjectTemplate> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO project_templates (id, name, description, icon, is_built_in, is_default, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.name,
        input.description ?? null,
        input.icon ?? null,
        boolToInt(input.isBuiltIn ?? false),
        boolToInt(input.isDefault ?? false),
        ts,
        ts,
      ]
    );
    return (await projectTemplates.getById(id))!;
  },

  async update(id: string, input: Partial<CreateProjectTemplateInput>): Promise<ProjectTemplate> {
    const db = await getDb();
    const ts = now();
    const sets: string[] = ["updated_at = $1"];
    const vals: unknown[] = [ts];
    let i = 2;
    if (input.name !== undefined) { sets.push(`name = $${i++}`); vals.push(input.name); }
    if (input.description !== undefined) { sets.push(`description = $${i++}`); vals.push(input.description); }
    if (input.icon !== undefined) { sets.push(`icon = $${i++}`); vals.push(input.icon); }
    if (input.isDefault !== undefined) { sets.push(`is_default = $${i++}`); vals.push(boolToInt(input.isDefault)); }
    vals.push(id);
    await db.execute(
      `UPDATE project_templates SET ${sets.join(", ")} WHERE id = $${i}`,
      vals
    );
    return (await projectTemplates.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM project_templates WHERE id = $1", [id]);
  },
};

export interface CreateProjectTemplateRoleInput {
  templateId: string;
  workRole: string;
  modelId: string;
  fallbackModelId?: string | null;
  order?: number;
  systemPrompt?: string | null;
  enabled?: boolean;
}

export const projectTemplateRoles = {
  async listByTemplate(templateId: string): Promise<ProjectTemplateRole[]> {
    const db = await getDb();
    const rows = await db.select<ProjectTemplateRoleRow[]>(
      `SELECT * FROM project_template_roles WHERE template_id = $1 ORDER BY "order" ASC`,
      [templateId]
    );
    return rows.map(rowToProjectTemplateRole);
  },

  async create(input: CreateProjectTemplateRoleInput): Promise<ProjectTemplateRole> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO project_template_roles
        (id, template_id, work_role, model_id, fallback_model_id, "order", system_prompt, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.templateId,
        input.workRole,
        input.modelId,
        input.fallbackModelId ?? null,
        input.order ?? 0,
        input.systemPrompt ?? null,
        boolToInt(input.enabled ?? true),
      ]
    );
    const rows = await db.select<ProjectTemplateRoleRow[]>(
      "SELECT * FROM project_template_roles WHERE id = $1",
      [id]
    );
    return rowToProjectTemplateRole(rows[0]!);
  },

  async update(id: string, input: Partial<CreateProjectTemplateRoleInput>): Promise<ProjectTemplateRole> {
    const db = await getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (input.modelId !== undefined) { sets.push(`model_id = $${i++}`); vals.push(input.modelId); }
    if (input.fallbackModelId !== undefined) { sets.push(`fallback_model_id = $${i++}`); vals.push(input.fallbackModelId); }
    if (input.systemPrompt !== undefined) { sets.push(`system_prompt = $${i++}`); vals.push(input.systemPrompt); }
    if (input.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(boolToInt(input.enabled)); }
    vals.push(id);
    await db.execute(
      `UPDATE project_template_roles SET ${sets.join(", ")} WHERE id = $${i}`,
      vals
    );
    const rows = await db.select<ProjectTemplateRoleRow[]>(
      "SELECT * FROM project_template_roles WHERE id = $1",
      [id]
    );
    return rowToProjectTemplateRole(rows[0]!);
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM project_template_roles WHERE id = $1", [id]);
  },
};

// ============ projects CRUD（4.2 / 9 节：Project + ProjectStage） ============

export interface Project {
  id: string;
  name: string;
  description: string | null;
  templateId: string | null;
  currentStage: string;
  status: string;
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;
  template?: { name: string };
}

export interface ProjectStage {
  id: string;
  projectId: string;
  workRole: string;
  modelId: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  outputSummary: string | null;
  errorMessage: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  template_id: string | null;
  current_stage: string;
  status: string;
  workspace_path: string | null;
  created_at: string;
  updated_at: string;
  template_name?: string;
}

interface ProjectStageRow {
  id: string;
  project_id: string;
  work_role: string;
  model_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  output_summary: string | null;
  error_message: string | null;
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    templateId: r.template_id,
    currentStage: r.current_stage,
    status: r.status,
    workspacePath: r.workspace_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.template_name !== undefined && { template: { name: r.template_name } }),
  };
}

function rowToProjectStage(r: ProjectStageRow): ProjectStage {
  return {
    id: r.id,
    projectId: r.project_id,
    workRole: r.work_role,
    modelId: r.model_id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    status: r.status,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cost: r.cost,
    outputSummary: r.output_summary,
    errorMessage: r.error_message,
  };
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  templateId?: string | null;
  workspacePath?: string | null;
}

export const projects = {
  async list(): Promise<Project[]> {
    const db = await getDb();
    const rows = await db.select<ProjectRow[]>(`
      SELECT p.*, t.name AS template_name
      FROM projects p
      LEFT JOIN project_templates t ON p.template_id = t.id
      ORDER BY p.updated_at DESC
    `);
    return rows.map(rowToProject);
  },

  async getById(id: string): Promise<Project | null> {
    const db = await getDb();
    const rows = await db.select<ProjectRow[]>(
      "SELECT * FROM projects WHERE id = $1",
      [id]
    );
    return rows[0] ? rowToProject(rows[0]) : null;
  },

  async create(input: CreateProjectInput): Promise<Project> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO projects (id, name, description, template_id, current_stage, status, workspace_path, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'main_chat','pending',$5,$6,$7)`,
      [id, input.name, input.description ?? null, input.templateId ?? null, input.workspacePath ?? null, ts, ts]
    );
    // 模板里"角色→模型"的分配已经在模板创建时定下了，新建项目时直接照着模板的角色清单
    // 生成对应的阶段（否则阶段时间线永远是空的，对话/检查点/接力包都无从谈起）
    if (input.templateId) {
      const roles = await projectTemplateRoles.listByTemplate(input.templateId);
      for (const role of roles.filter((r) => r.enabled)) {
        await projectStages.create({
          projectId: id,
          workRole: role.workRole,
          modelId: role.modelId,
        });
      }
    }
    return (await projects.getById(id))!;
  },

  async update(
    id: string,
    input: Partial<CreateProjectInput> & { currentStage?: string; status?: string }
  ): Promise<Project> {
    const db = await getDb();
    const ts = now();
    const sets: string[] = ["updated_at = $1"];
    const vals: unknown[] = [ts];
    let i = 2;
    if (input.name !== undefined) { sets.push(`name = $${i++}`); vals.push(input.name); }
    if (input.description !== undefined) { sets.push(`description = $${i++}`); vals.push(input.description); }
    if (input.workspacePath !== undefined) { sets.push(`workspace_path = $${i++}`); vals.push(input.workspacePath); }
    if (input.currentStage !== undefined) { sets.push(`current_stage = $${i++}`); vals.push(input.currentStage); }
    if (input.status !== undefined) { sets.push(`status = $${i++}`); vals.push(input.status); }
    vals.push(id);
    await db.execute(
      `UPDATE projects SET ${sets.join(", ")} WHERE id = $${i}`,
      vals
    );
    return (await projects.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM projects WHERE id = $1", [id]);
  },
};

export interface CreateProjectStageInput {
  projectId: string;
  workRole: string;
  modelId: string;
  status?: string;
}

export const projectStages = {
  async listByProject(projectId: string): Promise<ProjectStage[]> {
    const db = await getDb();
    const rows = await db.select<ProjectStageRow[]>(
      "SELECT * FROM project_stages WHERE project_id = $1 ORDER BY started_at ASC",
      [projectId]
    );
    return rows.map(rowToProjectStage);
  },

  async create(input: CreateProjectStageInput): Promise<ProjectStage> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO project_stages (id, project_id, work_role, model_id, started_at, status)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.projectId, input.workRole, input.modelId, ts, input.status ?? "pending"]
    );
    const rows = await db.select<ProjectStageRow[]>(
      "SELECT * FROM project_stages WHERE id = $1",
      [id]
    );
    return rowToProjectStage(rows[0]!);
  },

  async update(
    id: string,
    input: Partial<{
      status: string;
      completedAt: string | null;
      inputTokens: number;
      outputTokens: number;
      cost: number;
      outputSummary: string | null;
      errorMessage: string | null;
    }>
  ): Promise<ProjectStage> {
    const db = await getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (input.status !== undefined) { sets.push(`status = $${i++}`); vals.push(input.status); }
    if (input.completedAt !== undefined) { sets.push(`completed_at = $${i++}`); vals.push(input.completedAt); }
    if (input.inputTokens !== undefined) { sets.push(`input_tokens = $${i++}`); vals.push(input.inputTokens); }
    if (input.outputTokens !== undefined) { sets.push(`output_tokens = $${i++}`); vals.push(input.outputTokens); }
    if (input.cost !== undefined) { sets.push(`cost = $${i++}`); vals.push(input.cost); }
    if (input.outputSummary !== undefined) { sets.push(`output_summary = $${i++}`); vals.push(input.outputSummary); }
    if (input.errorMessage !== undefined) { sets.push(`error_message = $${i++}`); vals.push(input.errorMessage); }
    vals.push(id);
    await db.execute(
      `UPDATE project_stages SET ${sets.join(", ")} WHERE id = $${i}`,
      vals
    );
    const rows = await db.select<ProjectStageRow[]>(
      "SELECT * FROM project_stages WHERE id = $1",
      [id]
    );
    return rowToProjectStage(rows[0]!);
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM project_stages WHERE id = $1", [id]);
  },
};

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

// ============ usageEvents ============

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

// ============ handoffPackets CRUD（4.10：接力包 = 检查点字段拼成的 markdown）============

interface HandoffPacketRow {
  id: string;
  project_id: string;
  checkpoint_id: string;
  target_role: string;
  target_model_id: string | null;
  format: string;
  content: string;
  created_at: string;
}

export interface HandoffPacket {
  id: string;
  projectId: string;
  checkpointId: string;
  targetRole: string;
  targetModelId: string | null;
  format: string;
  content: string;
  createdAt: string;
}

function rowToHandoffPacket(r: HandoffPacketRow): HandoffPacket {
  return {
    id: r.id,
    projectId: r.project_id,
    checkpointId: r.checkpoint_id,
    targetRole: r.target_role,
    targetModelId: r.target_model_id,
    format: r.format,
    content: r.content,
    createdAt: r.created_at,
  };
}

export interface CreateHandoffPacketInput {
  projectId: string;
  checkpointId: string;
  targetRole: string;
  targetModelId?: string | null;
  format?: string;
  content: string;
}

/**
 * 把 Checkpoint 字段拼成给下一个角色看的 markdown 接力包
 * v0.7 i18n 化：接受 t 函数，让 markdown 标签跟用户当前语言走
 * （已存的旧 handoff 内容不会被重新翻译——只在新建时用新语言）
 */
export function renderHandoffMarkdown(
  cp: Checkpoint,
  targetRole: string,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  const section = (fieldKey: string, value: string | null): string[] => [
    `## ${t(`projectDetail.fields.${fieldKey}`)}`,
    value && value.trim() ? value.trim() : t("handoffMarkdown.empty"),
    "",
  ];
  const parts: string[] = [];
  parts.push(`# ${t("handoffMarkdown.title", { role: targetRole })}`);
  parts.push("");
  parts.push(t("handoffMarkdown.sourceCheckpoint", { title: cp.title }));
  parts.push(t("handoffMarkdown.generatedAt", { time: cp.createdAt }));
  parts.push("");
  parts.push(...section("goal", cp.goal));
  parts.push(...section("completedSummary", cp.completedSummary));
  parts.push(...section("currentContext", cp.currentContext));
  parts.push(...section("decisions", cp.decisions));
  parts.push(...section("failedAttempts", cp.failedAttempts));
  parts.push(...section("blockers", cp.blockers));
  parts.push(...section("nextSteps", cp.nextSteps));
  parts.push(...section("doNotRepeat", cp.doNotRepeat));
  parts.push(...section("acceptanceCriteria", cp.acceptanceCriteria));
  return parts.join("\n").trimEnd() + "\n";
}

export const handoffPackets = {
  async listByProject(projectId: string): Promise<HandoffPacket[]> {
    const db = await getDb();
    const rows = await db.select<HandoffPacketRow[]>(
      "SELECT * FROM handoff_packets WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    return rows.map(rowToHandoffPacket);
  },

  async getById(id: string): Promise<HandoffPacket | null> {
    const db = await getDb();
    const rows = await db.select<HandoffPacketRow[]>(
      "SELECT * FROM handoff_packets WHERE id = $1",
      [id]
    );
    return rows[0] ? rowToHandoffPacket(rows[0]) : null;
  },

  async create(input: CreateHandoffPacketInput): Promise<HandoffPacket> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO handoff_packets
        (id, project_id, checkpoint_id, target_role, target_model_id, format, content, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.projectId,
        input.checkpointId,
        input.targetRole,
        input.targetModelId ?? null,
        input.format ?? "markdown",
        input.content,
        ts,
      ]
    );
    return (await handoffPackets.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM handoff_packets WHERE id = $1", [id]);
  },

  /**
   * 把 checkpoint 字段拼成 markdown，生成一条 handoff_packets 记录。
   * checkpoint 不存在时抛错。
   * v0.7 i18n 化：接受 t 函数让内容跟当前语言走
   */
  async generate(
    checkpointId: string,
    targetRole: string,
    t: (k: string, opts?: Record<string, unknown>) => string,
    targetModelId?: string | null,
  ): Promise<HandoffPacket> {
    const cp = await checkpoints.getById(checkpointId);
    if (!cp) {
      throw new Error(`checkpoint ${checkpointId} not found`);
    }
    const content = renderHandoffMarkdown(cp, targetRole, t);
    return handoffPackets.create({
      projectId: cp.projectId,
      checkpointId,
      targetRole,
      targetModelId: targetModelId ?? null,
      content,
    });
  },
};

export const usageEvents = {
  async create(input: {
    providerId?: string | null;
    apiCredentialId?: string | null;
    modelId?: string | null;
    projectId?: string | null;
    role?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheHitTokens?: number;
    cost?: number;
    success?: boolean;
    interrupted?: boolean;
  }): Promise<void> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO usage_events
        (id, provider_id, api_credential_id, model_id, project_id, role,
         input_tokens, output_tokens, cache_creation_tokens, cache_hit_tokens,
         cost, success, interrupted, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        input.providerId ?? null,
        input.apiCredentialId ?? null,
        input.modelId ?? null,
        input.projectId ?? null,
        input.role ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cacheCreationTokens ?? 0,
        input.cacheHitTokens ?? 0,
        input.cost ?? 0,
        boolToInt(input.success ?? true),
        boolToInt(input.interrupted ?? false),
        ts,
      ]
    );
  },
};

// ============ projectMemories CRUD（v0.6 / 5.6 RAG） ============

export type MemoryKind = "decision" | "lesson" | "context" | "preference" | "other";

/**
 * 把 memory kind 翻译成当前语言的 label（v0.7 i18n 化：原本是硬编码中文常量）
 * UI 层调用：memoryKindLabel(m.kind, t) → "决策" / "Decision" 等
 */
export function memoryKindLabel(kind: string, t: (k: string) => string): string {
  const known: MemoryKind[] = ["decision", "lesson", "context", "preference", "other"];
  if ((known as string[]).includes(kind)) {
    return t(`memoryKind.${kind}`);
  }
  return kind;
}

export interface ProjectMemory {
  id: string;
  projectId: string;
  kind: string;
  title: string;
  content: string;
  importance: number;
  tags: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectMemoryRow {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  content: string;
  importance: number;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProjectMemory(r: ProjectMemoryRow): ProjectMemory {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    title: r.title,
    content: r.content,
    importance: r.importance,
    tags: r.tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateProjectMemoryInput {
  projectId: string;
  kind: string;
  title: string;
  content: string;
  importance?: number;
  tags?: string | null;
}

export const projectMemories = {
  async listByProject(projectId: string): Promise<ProjectMemory[]> {
    const db = await getDb();
    const rows = await db.select<ProjectMemoryRow[]>(
      "SELECT * FROM project_memories WHERE project_id = $1 ORDER BY importance DESC, created_at DESC",
      [projectId],
    );
    return rows.map(rowToProjectMemory);
  },

  async getById(id: string): Promise<ProjectMemory | null> {
    const db = await getDb();
    const rows = await db.select<ProjectMemoryRow[]>(
      "SELECT * FROM project_memories WHERE id = $1",
      [id],
    );
    return rows[0] ? rowToProjectMemory(rows[0]) : null;
  },

  async create(input: CreateProjectMemoryInput): Promise<ProjectMemory> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO project_memories (id, project_id, kind, title, content, importance, tags, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        input.projectId,
        input.kind,
        input.title,
        input.content,
        input.importance ?? 50,
        input.tags ?? null,
        ts,
        ts,
      ],
    );
    return (await projectMemories.getById(id))!;
  },

  async update(
    id: string,
    input: Partial<CreateProjectMemoryInput>,
  ): Promise<ProjectMemory> {
    const db = await getDb();
    const ts = now();
    const sets: string[] = ["updated_at = $1"];
    const vals: unknown[] = [ts];
    let i = 2;
    if (input.kind !== undefined) {
      sets.push(`kind = $${i++}`);
      vals.push(input.kind);
    }
    if (input.title !== undefined) {
      sets.push(`title = $${i++}`);
      vals.push(input.title);
    }
    if (input.content !== undefined) {
      sets.push(`content = $${i++}`);
      vals.push(input.content);
    }
    if (input.importance !== undefined) {
      sets.push(`importance = $${i++}`);
      vals.push(input.importance);
    }
    if (input.tags !== undefined) {
      sets.push(`tags = $${i++}`);
      vals.push(input.tags);
    }
    vals.push(id);
    await db.execute(
      `UPDATE project_memories SET ${sets.join(", ")} WHERE id = $${i}`,
      vals,
    );
    return (await projectMemories.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM project_memories WHERE id = $1", [id]);
  },

  /**
   * 跨项目检索：根据关键词在所有项目的记忆里做 LIKE 匹配。
   * 减负实现：不做 Embedding、不接外部 API，纯关键词 + importance 加权排序。
   * 适合「5 个项目 / 上千条记忆」以内的小白使用规模；规模化时再换向量检索。
   */
  async searchAcrossProjects(
    query: string,
    options: { limit?: number; excludeProjectId?: string } = {},
  ): Promise<ProjectMemory[]> {
    const limit = options.limit ?? 10;
    const db = await getDb();
    const q = query.trim();
    if (!q) return [];
    // 拆词 + 任何一词命中都行（OR），按 importance + 命中数排
    const tokens = q
      .split(/[\s,，、]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 1)
      .slice(0, 8);
    if (tokens.length === 0) return [];

    const likeConditions: string[] = [];
    const likeParams: unknown[] = [];
    tokens.forEach((tok, idx) => {
      const p = `$${idx + 1}`;
      likeConditions.push(`(title LIKE ${p} OR content LIKE ${p} OR tags LIKE ${p})`);
      likeParams.push(`%${tok}%`);
    });
    const excludeClause = options.excludeProjectId
      ? `AND project_id != $${likeParams.length + 1}`
      : "";
    if (options.excludeProjectId) likeParams.push(options.excludeProjectId);

    const sql = `
      SELECT *, (${likeConditions.map((c) => `CASE WHEN ${c} THEN 1 ELSE 0 END`).join(" + ")}) AS hits
      FROM project_memories
      WHERE (${likeConditions.join(" OR ")})
      ${excludeClause}
      ORDER BY (importance / 100.0 + hits * 0.1) DESC, created_at DESC
      LIMIT $${likeParams.length + 1}
    `;
    likeParams.push(limit);
    const rows = await db.select<ProjectMemoryRow[]>(sql, likeParams);
    return rows.map(rowToProjectMemory);
  },
};
