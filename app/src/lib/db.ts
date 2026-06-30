// 数据库层：tauri-plugin-sql 直连 SQLite
// 替代 server/db.ts + server/routes/factory.ts（Prisma + Hono）
// 所有 id 用 crypto.randomUUID()，Boolean 存 INTEGER，DateTime 存 TEXT ISO

import Database from "@tauri-apps/plugin-sql";
import { BUILT_IN_TEMPLATES, RETIRED_BUILT_IN_TEMPLATE_NAMES } from "./templates";
import { ROLE_IDS, type RoleId } from "./llm/orchestrator";
import { inferModelCapabilities } from "./llm/model-capabilities";
import type { IntentRouteAction } from "./workflow/semantic-intent-router";
import type { WorkflowRunStatus, WorkflowSnapshot } from "./workflow/types";

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

/** 幂等给表补列：列已存在则跳过（SQLite 无 ADD COLUMN IF NOT EXISTS，靠 PRAGMA 检查） */
async function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  decl: string,
): Promise<void> {
  const cols = await db.select<Array<{ name: string }>>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

async function repairCliPresetModels(db: Database): Promise<void> {
  const rows = await db.select<Array<{ id: string; name: string; provider_type: string }>>(`
    SELECT m.id, m.name, p.type AS provider_type
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE p.type IN ('claude-cli', 'codex-cli')
  `);

  for (const row of rows) {
    const normalized = row.name.toLowerCase().replace(/[\s_]/g, "-");
    let nextName: string | null = null;
    let nextDisplayName: string | null = null;

    if (row.provider_type === "claude-cli" && ["claude-opus-4-8", "opus"].includes(normalized)) {
      nextName = "sonnet";
      nextDisplayName = "Claude Sonnet";
    } else if (
      row.provider_type === "codex-cli" &&
      ["gpt-5.5-codex", "gpt5.5-codex", "gpt-5.5", "gpt5.5"].includes(normalized)
    ) {
      nextName = "gpt-5.5";
      nextDisplayName = "GPT 5.5";
    }

    if (!nextName) continue;
    const inferred = inferModelCapabilities(nextName);
    await db.execute(
      `UPDATE models
       SET name = $1, display_name = $2, capability_score = $3, work_roles = $4, updated_at = $5
       WHERE id = $6`,
      [
        nextName,
        nextDisplayName,
        JSON.stringify(inferred.capabilityScore),
        JSON.stringify(inferred.workRoles),
        now(),
        row.id,
      ],
    );
  }
}

async function clearIdleLeaderOnlyOrchestration(db: Database): Promise<void> {
  const rows = await db.select<Array<{ id: string; orchestration: string | null }>>(`
    SELECT id, orchestration
    FROM conversations
    WHERE orchestration IS NOT NULL AND orchestration <> ''
  `);

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.orchestration ?? "") as {
        nodes?: Array<{ role?: string; pinned?: boolean }>;
        chainPlan?: unknown[];
      };
      const nodes = parsed.nodes ?? [];
      const chainPlan = parsed.chainPlan ?? [];
      const isIdleLeaderOnly =
        nodes.length === 1 &&
        nodes[0]?.role === "leader" &&
        nodes[0]?.pinned !== true &&
        chainPlan.length === 0;

      if (isIdleLeaderOnly) {
        await db.execute("UPDATE conversations SET orchestration = NULL WHERE id = $1", [row.id]);
      }
    } catch {
      // 坏 JSON 不处理，避免误删用户真实工作链路。
    }
  }
}

/** 阶段 D：给指定会话查"8 角色绑定"。
 *  - 有 project → 查 project 的模板 → getRoleBindingsForTemplate
 *  - 无 project → 用"默认 8 角色"内置模板作兜底（ChatPage 主对话无 project 也能用角色绑定）
 *  - 查不到任何模板/绑定失败 → 返回空 Map（编排 fallback 自动选，原行为不变）
 *  - 单测可覆盖：mock dbConversations.getById 即可 */
export async function getRoleBindingsForConversation(convId: string): Promise<Map<RoleId, string>> {
  try {
    const conv = await conversations.getById(convId);
    let templateId: string | null = null;
    if (conv?.projectId) {
      const proj = await projects.getById(conv.projectId);
      templateId = proj?.templateId ?? null;
    }
    if (!templateId) {
      const db = await getDb();
      const rows = await db.select<Array<{ id: string }>>(
        'SELECT id FROM project_templates WHERE name = $1 AND is_built_in = 1 LIMIT 1',
        ['默认 8 角色'],
      );
      templateId = rows[0]?.id ?? null;
    }
    if (!templateId) return new Map();
    return projectTemplateRoles.getRoleBindingsForTemplate(templateId);
  } catch {
    return new Map();
  }
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

  // 迁移：主对话「编排者模式」——给旧库的 conversations 补 orchestration 列（存节点状态 JSON）。
  // 新库 CREATE 时未含该列（保持基线 schema 干净）；旧库靠幂等 ALTER 补上。
  await addColumnIfMissing(db, "conversations", "orchestration", "TEXT");

  // 迁移：主对话「工作文件夹」——给会话绑一个本地目录，AI 在此目录内读/改/跑命令（工具层 ToolContext.workspacePath）。
  // 符合产品真北：工作文件夹挂在「对话」上（上下文是中心），不强绑项目资产。旧库靠幂等 ALTER 补上。
  await addColumnIfMissing(db, "conversations", "workspace_path", "TEXT");

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
      attachments TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);
  // 迁移：消息附件（拖拽图片/文件，存 JSON）。旧库靠幂等 ALTER 补上。
  await addColumnIfMissing(db, "messages", "attachments", "TEXT");
  // 迁移：角色接力消息元数据。chain 每跳产出必须随会话恢复，不能只存在 React 内存里。
  await addColumnIfMissing(db, "messages", "actor_role", "TEXT");
  await addColumnIfMissing(db, "messages", "chain_step_index", "INTEGER");
  await addColumnIfMissing(db, "messages", "chain_step_total", "INTEGER");
  await addColumnIfMissing(db, "messages", "chain_done", "INTEGER");

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
      pricing_known INTEGER NOT NULL DEFAULT 1,
      price_version TEXT,
      price_source TEXT,
      price_catalog_id TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      interrupted INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      created_at TEXT NOT NULL
    )
  `);
  // 迁移：给旧库的 usage_events 补 outcome 列（改进-1 Step B 隐式信号）。
  // 新库 CREATE 时已含；旧库 IF NOT EXISTS 不改已存在表，故需幂等 ALTER。
  await addColumnIfMissing(db, "usage_events", "outcome", "TEXT");

  // 阶段 F1：给旧库的 usage_events 补 role_kind 列（actor 维度：leader/architect/frontend/.../stage/null）。
  // - 跟现有 `role` 列（workRole 难度桶：main_chat/planning/...）配对清晰，不撞名
  // - 聚合默认不过滤 NULL（review F1-1：leader 占比 80%+，NULL 是真实数据）
  // - NOT NULL 约束由 TypeScript 层保障（roleKind: RoleId | 'stage' | null）
  await addColumnIfMissing(db, "usage_events", "role_kind", "TEXT");
  await addColumnIfMissing(db, "usage_events", "conversation_id", "TEXT");
  // 用量监控阶段：未知模型价格不能继续被默默当成 0 元。
  // 旧数据默认 1，避免把历史已估算记录误标成未知。
  await addColumnIfMissing(db, "usage_events", "pricing_known", "INTEGER NOT NULL DEFAULT 1");
  await addColumnIfMissing(db, "usage_events", "price_version", "TEXT");
  await addColumnIfMissing(db, "usage_events", "price_source", "TEXT");
  await addColumnIfMissing(db, "usage_events", "price_catalog_id", "TEXT");

  // 索引：① setOutcomeForLatest 按 model_id + outcome IS NULL 取最近一条（隐式反馈热路径）；
  //        ② usageEvents.list 按 created_at 过滤/排序（统计 + SmartRouter 数据源）；
  //        ③ F1 阶段：按 role_kind × model_id 聚合（覆盖 GROUP BY 前缀 + 时间排序）
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_usage_events_model_outcome ON usage_events(model_id, created_at DESC) WHERE outcome IS NULL"
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at)"
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_usage_events_role_kind_model ON usage_events(role_kind, model_id, created_at DESC)"
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_usage_events_price_catalog ON usage_events(price_catalog_id, created_at DESC)"
  );

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
  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_memory_vectors (
      memory_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      dim INTEGER NOT NULL,
      embedding_json TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, provider_name),
      FOREIGN KEY (memory_id) REFERENCES project_memories(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_project_memory_vectors_lookup
    ON project_memory_vectors(provider_name, project_id, indexed_at DESC)
  `);

  // v0.9 阶段7：模型表现滚动统计（SmartRouter 评分数据源）
  // 一行 = 某模型在某难度桶（simple/standard/hard）上的累积表现；每写 UsageEvent 增量更新
  await db.execute(`
    CREATE TABLE IF NOT EXISTS model_performance_stats (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      success_rate REAL NOT NULL DEFAULT 1,
      avg_input_tokens REAL NOT NULL DEFAULT 0,
      avg_output_tokens REAL NOT NULL DEFAULT 0,
      avg_cost REAL NOT NULL DEFAULT 0,
      avg_latency_ms REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (model_id, task_type)
    )
  `);

  // v0.9 阶段7：语义缓存（重复/相似 query 命中已有答案，省 token）
  // query_embedding 存 JSON float[]；检索时纯 JS 余弦扫描（自用阶段量小够用）
  await db.execute(`
    CREATE TABLE IF NOT EXISTS semantic_cache (
      id TEXT PRIMARY KEY,
      query_text TEXT NOT NULL,
      query_embedding TEXT NOT NULL,
      response_text TEXT NOT NULL,
      model_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      provider_name TEXT NOT NULL DEFAULT 'keyword-hash',
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  // v0.9.1：老库可能没 provider_name 列，补上（写时按当前 provider name 算）
  await addColumnIfMissing(db, "semantic_cache", "provider_name", "TEXT NOT NULL DEFAULT 'keyword-hash'");
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_semantic_cache_expires
    ON semantic_cache(expires_at)
  `);

  // 价格目录：内置默认价 + 远程同步价 + 用户手动覆盖价。
  // 允许保留多版本，usage_events.price_version 会把历史调用绑定到当时价格版本。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS model_price_catalog (
      id TEXT PRIMARY KEY,
      model_name TEXT NOT NULL,
      provider_type TEXT,
      input_per_1m REAL NOT NULL,
      output_per_1m REAL NOT NULL,
      cache_read_per_1m REAL,
      cache_write_per_1m REAL,
      context_window INTEGER,
      source TEXT NOT NULL,
      source_url TEXT,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_model_price_catalog_lookup
    ON model_price_catalog(model_name, provider_type, enabled, source, updated_at DESC)
  `);

  // 价格同步状态：只存一条全局状态，用于 UI 展示“上次更新时间 / 失败原因”。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS price_sync_status (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_url TEXT,
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      catalog_version TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS savings_events (
      id TEXT PRIMARY KEY,
      usage_event_id TEXT,
      conversation_id TEXT,
      project_id TEXT,
      kind TEXT NOT NULL,
      baseline_model_id TEXT,
      actual_model_id TEXT,
      baseline_cost REAL NOT NULL,
      actual_cost REAL NOT NULL,
      saved_cost REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      formula_version TEXT NOT NULL,
      explain_json TEXT NOT NULL,
      actual_price_catalog_id TEXT,
      baseline_price_catalog_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await addColumnIfMissing(db, "savings_events", "actual_price_catalog_id", "TEXT");
  await addColumnIfMissing(db, "savings_events", "baseline_price_catalog_id", "TEXT");
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_savings_events_created
    ON savings_events(created_at DESC)
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_savings_events_usage_kind
    ON savings_events(usage_event_id, kind)
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS cli_sessions (
      id TEXT PRIMARY KEY,
      provider_type TEXT NOT NULL,
      conversation_id TEXT,
      project_id TEXT,
      official_session_id TEXT NOT NULL,
      model_name TEXT,
      program TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_event_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cli_sessions_official
    ON cli_sessions(provider_type, official_session_id)
  `);

  // v0.8 阶段5：多角色对弈会话（Solver/Critic/Judge 协作的一次实例）
  // rounds 存 JSON（每轮 role/modelId/content/token），避免另建 DebateRound 表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS debate_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      topic TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      quick_mode INTEGER NOT NULL DEFAULT 0,
      rounds TEXT NOT NULL DEFAULT '[]',
      final_solution TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_debate_sessions_created
    ON debate_sessions(created_at DESC)
  `);

  // v0.7 阶段4：工具执行审计（每次工具调用一条，可追溯）
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      conversation_id TEXT,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      status TEXT NOT NULL,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      reversible INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_tool_executions_created
    ON tool_executions(created_at DESC)
  `);

  // v0.7 阶段4b：项目级工具安全配置（自定义命令黑名单，叠加在内置白名单之上）
  await db.execute(`
    CREATE TABLE IF NOT EXISTS workspace_configs (
      project_id TEXT PRIMARY KEY,
      blocked_commands TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    )
  `);

  // v0.10：任务工作流状态。区别于 conversations.orchestration（角色链 UI），这里保存“任务做到哪一步”。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      project_id TEXT,
      status TEXT NOT NULL,
      current_phase TEXT,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation_status
    ON workflow_runs(conversation_id, status, updated_at)
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS workflow_events (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_workflow_events_run_created
    ON workflow_events(workflow_run_id, created_at)
  `);

  // v0.10：意图识别自我成长。样例用于语义路由，反馈事件用于后续沉淀/降权。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS intent_examples (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      text TEXT NOT NULL,
      explanation TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      weight REAL NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_intent_examples_action_enabled
    ON intent_examples(action, enabled, updated_at)
  `);
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_examples_action_text
    ON intent_examples(action, text)
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS intent_feedback_events (
      id TEXT PRIMARY KEY,
      user_text TEXT NOT NULL,
      predicted_action TEXT NOT NULL,
      corrected_action TEXT NOT NULL,
      workflow_state TEXT,
      source TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_intent_feedback_created
    ON intent_feedback_events(created_at DESC)
  `);

  await repairCliPresetModels(db);
  await clearIdleLeaderOnlyOrchestration(db);
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
    // 阶段 D：给"默认 8 角色"内置模板额外 seed 8 条 RoleId 行（workRole=RoleId，modelId=null），
    // 让用户在 TemplatesPage 编辑后即生效。workRole=RoleId 一列一义，老模板 13 枚举 workRole 行不在 8 角色绑定路径里解释。
    if (tpl.workRoles.every((r) => (ROLE_IDS as readonly string[]).includes(r))) {
      await seedDefaultRoleRowsForTemplate(tpl.name);
    }
  }
}

/** 阶段 D 辅助：给"默认 8 角色"模板 seed 8 条 RoleId=workRole 行
 *  - model_id 用空字符串占位（schema 约束 NOT NULL，用户没绑前显示空下拉；getRoleBindingsForTemplate 看到空字符串 falsy 会跳过）
 *  - ON CONFLICT(template_id, work_role) DO NOTHING：已 seed 过的不重复插入
 *  - 仅写 workRole IN ROLE_IDS 的行；老 13 枚举 workRole 行不在此函数职责范围内 */
async function seedDefaultRoleRowsForTemplate(templateName: string): Promise<void> {
  const db = await getDb();
  const tplRows = await db.select<Array<{ id: string }>>(
    "SELECT id FROM project_templates WHERE name = $1 AND is_built_in = 1 LIMIT 1",
    [templateName],
  );
  const templateId = tplRows[0]?.id;
  if (!templateId) return;
  for (let i = 0; i < ROLE_IDS.length; i++) {
    const role = ROLE_IDS[i]!;
    await db.execute(
      `INSERT INTO project_template_roles (id, template_id, work_role, model_id, fallback_model_id, "order", system_prompt, enabled)
       VALUES ($1,$2,$3,'',NULL,$4,NULL,1)
       ON CONFLICT(template_id, work_role) DO NOTHING`,
      [newId(), templateId, role, i],
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
      vals
    );
    return (await models.getById(id))!;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM models WHERE id = $1", [id]);
  },
};

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

// ============ conversations CRUD ============

export interface ConversationRow {
  id: string;
  project_id: string | null;
  title: string;
  default_model_id: string | null;
  workspace_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  projectId: string | null;
  title: string;
  defaultModelId: string | null;
  /** 本地工作文件夹（AI 工具在此目录内读/改/跑命令）；未绑定为 null */
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;
}

// 单一映射出口：加字段时只改这里，杜绝多处 SELECT mapper 漏字段。
function mapConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    defaultModelId: r.default_model_id,
    workspacePath: r.workspace_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
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
  attachments: string | null;
  actor_role: string | null;
  chain_step_index: number | null;
  chain_step_total: number | null;
  chain_done: number | null;
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
  attachments?: string | null;
  actorRole?: string | null;
  chainStepIndex?: number | null;
  chainStepTotal?: number | null;
  chainDone?: boolean | null;
  createdAt: string;
}

function mapMessageRow(r: MessageRow): DbMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    modelId: r.model_id,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cost: r.cost,
    attachments: r.attachments,
    actorRole: r.actor_role,
    chainStepIndex: r.chain_step_index,
    chainStepTotal: r.chain_step_total,
    chainDone: r.chain_done === null ? null : r.chain_done === 1,
    createdAt: r.created_at,
  };
}

export const conversations = {
  async list(): Promise<Conversation[]> {
    const db = await getDb();
    const rows = await db.select<ConversationRow[]>(
      "SELECT * FROM conversations ORDER BY updated_at DESC"
    );
    return rows.map(mapConversation);
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
    return mapConversation(rows[0]!);
  },

  // 主对话（无项目归属）的单例会话：取最近一条 project_id IS NULL 的会话，没有则建一条。
  // 让 ChatPage 主聊天像项目阶段对话一样落库，关 app 不丢上下文（产品真北：上下文是用户的资产）。
  async getOrCreateMainChat(defaultModelId?: string | null, title = "Main Chat"): Promise<Conversation> {
    const db = await getDb();
    const rows = await db.select<ConversationRow[]>(
      "SELECT * FROM conversations WHERE project_id IS NULL ORDER BY updated_at DESC LIMIT 1"
    );
    const r = rows[0];
    if (r) {
      return mapConversation(r);
    }
    return this.create({ title, defaultModelId: defaultModelId ?? null, projectId: null });
  },

  // 列出全部主对话（无项目归属），最近活跃在前——ChatPage 多会话侧栏用。
  async listMainChats(): Promise<Conversation[]> {
    const db = await getDb();
    const rows = await db.select<ConversationRow[]>(
      "SELECT * FROM conversations WHERE project_id IS NULL ORDER BY updated_at DESC"
    );
    return rows.map(mapConversation);
  },

  // 改标题（首条消息自动命名 / 用户手动重命名）。顺带 bump updated_at 让它排到最前。
  async rename(id: string, title: string): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3", [title, now(), id]);
  },

  // 用户手动切换顶部模型时，回写会话默认模型，保证重启后仍沿用用户最后一次选择。
  async setDefaultModelId(id: string, defaultModelId: string | null): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE conversations SET default_model_id = $1, updated_at = $2 WHERE id = $3",
      [defaultModelId, now(), id],
    );
  },

  // bump updated_at（有新消息时调，保证侧栏按最近活跃排序）。
  async touch(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE conversations SET updated_at = $1 WHERE id = $2", [now(), id]);
  },

  // 删除会话（messages 经 FK ON DELETE CASCADE 一并删）。
  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM conversations WHERE id = $1", [id]);
  },

  // 阶段 D：查单个会话（拿到 projectId，用于查模板 → 角色绑定）。没找到返 null。
  async getById(id: string): Promise<Conversation | null> {
    const db = await getDb();
    const rows = await db.select<ConversationRow[]>(
      "SELECT * FROM conversations WHERE id = $1 LIMIT 1",
      [id],
    );
    return rows[0] ? mapConversation(rows[0]) : null;
  },

  // 读编排者节点状态 JSON（没有则 null）。编排是后台锦上添花，列可能不存在的旧库已被 initSchema 迁移补上。
  async getOrchestration(id: string): Promise<string | null> {
    const db = await getDb();
    const rows = await db.select<Array<{ orchestration: string | null }>>(
      "SELECT orchestration FROM conversations WHERE id = $1",
      [id]
    );
    return rows[0]?.orchestration ?? null;
  },

  // 写编排者节点状态 JSON。故意不 bump updated_at——后台编排不该把会话顶到侧栏最前。
  async saveOrchestration(id: string, json: string): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE conversations SET orchestration = $1 WHERE id = $2", [json, id]);
  },

  // 绑定/解绑会话的本地工作文件夹（传 null 解绑）。不 bump updated_at——绑目录不算新消息。
  async setWorkspacePath(id: string, path: string | null): Promise<void> {
    const db = await getDb();
    await db.execute("UPDATE conversations SET workspace_path = $1 WHERE id = $2", [path, id]);
  },
};

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
};

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
};

export const messages = {
  async listByConversation(conversationId: string): Promise<DbMessage[]> {
    const db = await getDb();
    const rows = await db.select<MessageRow[]>(
      "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversationId]
    );
    return rows.map(mapMessageRow);
  },

  async create(input: {
    conversationId: string;
    role: string;
    content: string;
    modelId?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    attachments?: string | null;
    actorRole?: string | null;
    chainStepIndex?: number | null;
    chainStepTotal?: number | null;
    chainDone?: boolean | null;
  }): Promise<DbMessage> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO messages
        (id, conversation_id, role, content, model_id, input_tokens, output_tokens, cost, attachments,
         actor_role, chain_step_index, chain_step_total, chain_done, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        input.conversationId,
        input.role,
        input.content,
        input.modelId ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cost ?? 0,
        input.attachments ?? null,
        input.actorRole ?? null,
        input.chainStepIndex ?? null,
        input.chainStepTotal ?? null,
        input.chainDone === undefined || input.chainDone === null ? null : boolToInt(input.chainDone),
        ts,
      ]
    );
    const rows = await db.select<MessageRow[]>("SELECT * FROM messages WHERE id = $1", [id]);
    return mapMessageRow(rows[0]!);
  },

  async updateChainMessage(id: string, input: {
    content?: string;
    chainDone?: boolean | null;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    modelId?: string | null;
  }): Promise<DbMessage | null> {
    const db = await getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (input.content !== undefined) { sets.push(`content = $${i++}`); vals.push(input.content); }
    if (input.chainDone !== undefined) { sets.push(`chain_done = $${i++}`); vals.push(input.chainDone === null ? null : boolToInt(input.chainDone)); }
    if (input.inputTokens !== undefined) { sets.push(`input_tokens = $${i++}`); vals.push(input.inputTokens); }
    if (input.outputTokens !== undefined) { sets.push(`output_tokens = $${i++}`); vals.push(input.outputTokens); }
    if (input.cost !== undefined) { sets.push(`cost = $${i++}`); vals.push(input.cost); }
    if (input.modelId !== undefined) { sets.push(`model_id = $${i++}`); vals.push(input.modelId); }
    if (sets.length === 0) {
      const rows = await db.select<MessageRow[]>("SELECT * FROM messages WHERE id = $1", [id]);
      return rows[0] ? mapMessageRow(rows[0]) : null;
    }
    vals.push(id);
    await db.execute(`UPDATE messages SET ${sets.join(", ")} WHERE id = $${i}`, vals);
    const rows = await db.select<MessageRow[]>("SELECT * FROM messages WHERE id = $1", [id]);
    return rows[0] ? mapMessageRow(rows[0]) : null;
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
    const retiredNames = new Set<string>(RETIRED_BUILT_IN_TEMPLATE_NAMES);
    return rows
      .map(rowToProjectTemplate)
      .filter((tpl) => !(tpl.isBuiltIn && retiredNames.has(tpl.name)));
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

  /** 阶段 D：从指定模板读"8 角色绑定"（workRole=RoleId 行）→ Map<RoleId, modelId>
   *  - 一列一义：只查 workRole IN ROLE_IDS 的行；老模板的 13 枚举 workRole 行不进 Map
   *  - enabled=false 的行不进 Map（用户禁用的角色不参与编排）
   *  - modelId 空/全空白不进 Map（用户没绑 = 不该塞个空绑定到 Map，编排 L2 会用空字符串查 availableModels 失败再走 L3 fallback——多走一步弯路；这里直接跳过更干净）
   *  - 返回 Map 而非 Record：调用方 resolveOrchestration 直接 roleBindings.get(role) 查
   *  - 纯函数；无 IO 副作用（除了 listByTemplate 的 SELECT）
   */
  async getRoleBindingsForTemplate(templateId: string): Promise<Map<RoleId, string>> {
    const rows = await this.listByTemplate(templateId);
    const map = new Map<RoleId, string>();
    const allowedRoles = new Set<string>(ROLE_IDS);
    for (const r of rows) {
      if (!allowedRoles.has(r.workRole)) continue; // 老 13 枚举 workRole 行跳过（一列一义）
      if (!r.enabled) continue; // 禁用的角色跳过
      if (!r.modelId || !r.modelId.trim()) continue; // 空字符串/全空白占位行跳过（不把空绑定塞进 Map——省编排 L2 多走一步 fallback）
      map.set(r.workRole as RoleId, r.modelId);
    }
    return map;
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
    // 生成对应的阶段（否则阶段时间线永远是空的，对话/检查点/交接包都无从谈起）
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

// ============ handoffPackets CRUD（4.10：交接包 = 检查点字段拼成的 markdown）============

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
 * 把 Checkpoint 字段拼成给下一个角色看的 markdown 交接包
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
    conversationId?: string | null;
    role?: string | null;
    /** 阶段 F1：actor 维度（leader/architect/frontend/.../stage/null） */
    roleKind?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheHitTokens?: number;
    cost?: number;
    pricingKnown?: boolean;
    priceVersion?: string | null;
    priceSource?: string | null;
    priceCatalogId?: string | null;
    success?: boolean;
    interrupted?: boolean;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO usage_events
        (id, provider_id, api_credential_id, model_id, project_id, conversation_id, role, role_kind,
         input_tokens, output_tokens, cache_creation_tokens, cache_hit_tokens,
         cost, pricing_known, price_version, price_source, price_catalog_id, success, interrupted, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        id,
        input.providerId ?? null,
        input.apiCredentialId ?? null,
        input.modelId ?? null,
        input.projectId ?? null,
        input.conversationId ?? null,
        input.role ?? null,
        // 阶段 F1：role_kind 透传（undefined → NULL；review F1-1 聚合不过滤 NULL）
        input.roleKind ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cacheCreationTokens ?? 0,
        input.cacheHitTokens ?? 0,
        input.cost ?? 0,
        boolToInt(input.pricingKnown ?? true),
        input.priceVersion ?? null,
        input.priceSource ?? null,
        input.priceCatalogId ?? null,
        boolToInt(input.success ?? true),
        boolToInt(input.interrupted ?? false),
        ts,
      ]
    );
    return id;
  },

  /**
   * 给某模型「最近一条还没被评价（outcome IS NULL）的回答」打上 outcome 标签。
   * 改进-1 Step B：采集点（用户重答 / 手动切回贵模型 / 回滚）不必透传 UsageEvent id，
   * 只要知道"哪个模型刚答得不满意"。返回该事件的 taskType（=role 存的难度桶）供喂回评分；无则 null。
   */
  async setOutcomeForLatest(
    modelId: string,
    outcome: string,
  ): Promise<{ taskType: string | null } | null> {
    const db = await getDb();
    const rows = await db.select<Array<{ id: string; role: string | null }>>(
      "SELECT id, role FROM usage_events WHERE model_id = $1 AND outcome IS NULL ORDER BY created_at DESC LIMIT 1",
      [modelId],
    );
    if (rows.length === 0) return null;
    await db.execute("UPDATE usage_events SET outcome = $1 WHERE id = $2", [outcome, rows[0]!.id]);
    return { taskType: rows[0]!.role };
  },

  /** 列出用量事件（StatsPage 统计用）。sinceTs 可选，只取该 ISO 时间之后的 */
  async list(sinceTs?: string): Promise<UsageEventRow[]> {
    const db = await getDb();
    const rows = sinceTs
      ? await db.select<any[]>(
          "SELECT id, provider_id, api_credential_id, model_id, project_id, conversation_id, role, role_kind, input_tokens, output_tokens, cache_creation_tokens, cache_hit_tokens, cost, pricing_known, price_version, price_source, price_catalog_id, success, created_at FROM usage_events WHERE created_at >= $1 ORDER BY created_at ASC",
          [sinceTs],
        )
      : await db.select<any[]>(
          "SELECT id, provider_id, api_credential_id, model_id, project_id, conversation_id, role, role_kind, input_tokens, output_tokens, cache_creation_tokens, cache_hit_tokens, cost, pricing_known, price_version, price_source, price_catalog_id, success, created_at FROM usage_events ORDER BY created_at ASC",
        );
    return rows.map((r) => ({
      id: r.id,
      providerId: r.provider_id ?? null,
      apiCredentialId: r.api_credential_id ?? null,
      modelId: r.model_id,
      projectId: r.project_id ?? null,
      conversationId: r.conversation_id ?? null,
      role: r.role,
      // 阶段 F1：role_kind 透传到聚合（NULL → 未分类组）
      roleKind: r.role_kind ?? null,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheCreationTokens: r.cache_creation_tokens ?? 0,
      cacheHitTokens: r.cache_hit_tokens ?? 0,
      cost: r.cost,
      pricingKnown: r.pricing_known !== 0,
      priceVersion: r.price_version ?? null,
      priceSource: r.price_source ?? null,
      priceCatalogId: r.price_catalog_id ?? null,
      success: !!r.success,
      createdAt: r.created_at,
    }));
  },
};

export interface UsageEventRow {
  id: string;
  providerId: string | null;
  apiCredentialId: string | null;
  modelId: string | null;
  projectId: string | null;
  conversationId: string | null;
  role: string | null;
  /** 阶段 F1：actor 维度（leader/architect/frontend/.../stage/null） */
  roleKind: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheHitTokens: number;
  cost: number;
  pricingKnown: boolean;
  priceVersion: string | null;
  priceSource: string | null;
  priceCatalogId: string | null;
  success: boolean;
  createdAt: string;
}

// ============ modelPerformanceStats CRUD（v0.9 阶段7：SmartRouter 评分数据源） ============

export interface ModelPerformanceStatRow {
  modelId: string;
  taskType: string;
  successRate: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCost: number;
  avgLatencyMs: number;
  sampleCount: number;
  windowStart: string;
  windowEnd: string;
}

function mapPerfRow(r: any): ModelPerformanceStatRow {
  return {
    modelId: r.model_id,
    taskType: r.task_type,
    successRate: r.success_rate,
    avgInputTokens: r.avg_input_tokens,
    avgOutputTokens: r.avg_output_tokens,
    avgCost: r.avg_cost,
    avgLatencyMs: r.avg_latency_ms,
    sampleCount: r.sample_count,
    windowStart: r.window_start,
    windowEnd: r.window_end,
  };
}

export const modelPerformanceStats = {
  /** 按 (modelId, taskType) 取一条统计，无则 null */
  async get(modelId: string, taskType: string): Promise<ModelPerformanceStatRow | null> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM model_performance_stats WHERE model_id = $1 AND task_type = $2 LIMIT 1",
      [modelId, taskType]
    );
    return rows.length > 0 ? mapPerfRow(rows[0]) : null;
  },

  /** upsert：按 (model_id, task_type) 唯一键插入或整行更新 */
  async upsert(stat: ModelPerformanceStatRow): Promise<void> {
    const db = await getDb();
    const ts = now();
    await db.execute(
      `INSERT INTO model_performance_stats
        (id, model_id, task_type, success_rate, avg_input_tokens, avg_output_tokens,
         avg_cost, avg_latency_ms, sample_count, window_start, window_end, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(model_id, task_type) DO UPDATE SET
         success_rate = excluded.success_rate,
         avg_input_tokens = excluded.avg_input_tokens,
         avg_output_tokens = excluded.avg_output_tokens,
         avg_cost = excluded.avg_cost,
         avg_latency_ms = excluded.avg_latency_ms,
         sample_count = excluded.sample_count,
         window_start = excluded.window_start,
         window_end = excluded.window_end,
         updated_at = excluded.updated_at`,
      [
        newId(), stat.modelId, stat.taskType, stat.successRate, stat.avgInputTokens,
        stat.avgOutputTokens, stat.avgCost, stat.avgLatencyMs, stat.sampleCount,
        stat.windowStart, stat.windowEnd, ts,
      ]
    );
  },

  /** 列出全部统计（StatsPage / SmartRouter 评分用） */
  async list(): Promise<ModelPerformanceStatRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>("SELECT * FROM model_performance_stats");
    return rows.map(mapPerfRow);
  },
};

// ============ semanticCache CRUD（v0.9 阶段7：语义缓存） ============

export interface SemanticCacheRow {
  id: string;
  queryText: string;
  queryEmbedding: number[];
  responseText: string;
  modelId: string;
  taskType: string;
  /** embedding provider 名（如 'keyword-hash-v2'）——lookup 时不匹配直接跳过 */
  providerName: string;
  hitCount: number;
  lastHitAt: string | null;
  expiresAt: string;
  createdAt: string;
}

function mapCacheRow(r: any): SemanticCacheRow {
  return {
    id: r.id,
    queryText: r.query_text,
    queryEmbedding: JSON.parse(r.query_embedding),
    responseText: r.response_text,
    modelId: r.model_id,
    taskType: r.task_type,
    // 老库可能没 provider_name 列（DEFAULT 'keyword-hash'）— 安全降级
    providerName: r.provider_name ?? "keyword-hash",
    hitCount: r.hit_count,
    lastHitAt: r.last_hit_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

export const semanticCache = {
  /** 写入一条缓存 */
  async create(input: {
    queryText: string;
    queryEmbedding: number[];
    responseText: string;
    modelId: string;
    taskType: string;
    expiresAt: string;
    /** embedding provider 名（写入时按当前 provider.name 取） */
    providerName?: string;
  }): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT INTO semantic_cache
        (id, query_text, query_embedding, response_text, model_id, task_type,
         provider_name, hit_count, last_hit_at, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,NULL,$8,$9)`,
      [
        newId(), input.queryText, JSON.stringify(input.queryEmbedding), input.responseText,
        input.modelId, input.taskType, input.providerName ?? "keyword-hash",
        input.expiresAt, now(),
      ]
    );
  },

  /** 列出所有未过期缓存（检索时纯 JS 余弦扫描） */
  async listValid(): Promise<SemanticCacheRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM semantic_cache WHERE expires_at > $1",
      [now()]
    );
    return rows.map(mapCacheRow);
  },

  /** 命中后累加命中次数 + 更新 last_hit_at */
  async recordHit(id: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE semantic_cache SET hit_count = hit_count + 1, last_hit_at = $1 WHERE id = $2",
      [now(), id]
    );
  },

  /** 清理过期缓存，返回删除条数 */
  async deleteExpired(): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM semantic_cache WHERE expires_at <= $1", [now()]);
  },

  /** 清空全部缓存（用户在用量页手动重置，或旧脏缓存一键清掉） */
  async deleteAll(): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM semantic_cache");
  },

  /** 缓存统计：条目数 + 累计命中次数（StatsPage 用） */
  async stats(): Promise<{ entries: number; totalHits: number }> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT COUNT(*) AS entries, COALESCE(SUM(hit_count), 0) AS total_hits FROM semantic_cache"
    );
    const r = rows[0] ?? { entries: 0, total_hits: 0 };
    return { entries: Number(r.entries) || 0, totalHits: Number(r.total_hits) || 0 };
  },
};

// ============ debateSessions CRUD（v0.8 阶段5：多角色对弈） ============

export interface DebateRoundData {
  role: string;
  modelId: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface DebateSessionRow {
  id: string;
  projectId: string | null;
  topic: string;
  status: string;
  quickMode: boolean;
  rounds: DebateRoundData[];
  finalSolution: string | null;
  createdAt: string;
  completedAt: string | null;
}

function mapDebateRow(r: any): DebateSessionRow {
  return {
    id: r.id,
    projectId: r.project_id,
    topic: r.topic,
    status: r.status,
    quickMode: !!r.quick_mode,
    rounds: JSON.parse(r.rounds || "[]"),
    finalSolution: r.final_solution,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

export const debateSessions = {
  /** 保存一场完成的对弈 */
  async create(input: {
    projectId?: string | null;
    topic: string;
    quickMode: boolean;
    rounds: DebateRoundData[];
    finalSolution: string;
    status?: string;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO debate_sessions
        (id, project_id, topic, status, quick_mode, rounds, final_solution, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id, input.projectId ?? null, input.topic, input.status ?? "completed",
        boolToInt(input.quickMode), JSON.stringify(input.rounds), input.finalSolution, ts, ts,
      ]
    );
    return id;
  },

  /** 列出历史对弈（最近在前） */
  async list(limit = 50): Promise<DebateSessionRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM debate_sessions ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return rows.map(mapDebateRow);
  },

  async getById(id: string): Promise<DebateSessionRow | null> {
    const db = await getDb();
    const rows = await db.select<any[]>("SELECT * FROM debate_sessions WHERE id = $1", [id]);
    return rows.length > 0 ? mapDebateRow(rows[0]) : null;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM debate_sessions WHERE id = $1", [id]);
  },
};

// ============ toolExecutions CRUD（v0.7 阶段4：工具执行审计） ============

export interface ToolExecutionRow {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  toolName: string;
  input: string;
  output: string;
  status: string;
  userConfirmed: boolean;
  reversible: boolean;
  durationMs: number;
  createdAt: string;
}

function mapToolExecRow(r: any): ToolExecutionRow {
  return {
    id: r.id,
    projectId: r.project_id,
    conversationId: r.conversation_id,
    toolName: r.tool_name,
    input: r.input,
    output: r.output,
    status: r.status,
    userConfirmed: !!r.user_confirmed,
    reversible: !!r.reversible,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  };
}

export const toolExecutions = {
  async create(input: {
    projectId?: string | null;
    conversationId?: string | null;
    toolName: string;
    input: string;
    output: string;
    status: string;
    userConfirmed?: boolean;
    reversible?: boolean;
    durationMs: number;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO tool_executions
        (id, project_id, conversation_id, tool_name, input, output, status,
         user_confirmed, reversible, duration_ms, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, input.projectId ?? null, input.conversationId ?? null, input.toolName,
        input.input, input.output, input.status,
        boolToInt(input.userConfirmed ?? false), boolToInt(input.reversible ?? false),
        input.durationMs, now(),
      ]
    );
    return id;
  },

  /** 列出最近的工具执行（审计/侧边栏用） */
  async list(limit = 100): Promise<ToolExecutionRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM tool_executions ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return rows.map(mapToolExecRow);
  },

  async listByConversation(conversationId: string): Promise<ToolExecutionRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM tool_executions WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversationId]
    );
    return rows.map(mapToolExecRow);
  },
};

// ============ workspaceConfigs CRUD（v0.7 阶段4b：项目级工具安全配置） ============

export const workspaceConfigs = {
  /** 取项目的自定义命令黑名单（无配置返回空数组） */
  async getBlockedCommands(projectId: string): Promise<string[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT blocked_commands FROM workspace_configs WHERE project_id = $1",
      [projectId]
    );
    if (rows.length === 0) return [];
    try {
      return JSON.parse(rows[0].blocked_commands || "[]");
    } catch {
      return [];
    }
  },

  /** 设置项目的自定义命令黑名单 */
  async setBlockedCommands(projectId: string, blocked: string[]): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT INTO workspace_configs (project_id, blocked_commands, updated_at)
       VALUES ($1,$2,$3)
       ON CONFLICT(project_id) DO UPDATE SET blocked_commands = excluded.blocked_commands, updated_at = excluded.updated_at`,
      [projectId, JSON.stringify(blocked), now()]
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
  projectName?: string | null;
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
  project_name?: string | null;
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
    projectName: r.project_name ?? null,
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

export interface SearchProjectMemoriesOptions {
  limit?: number;
  excludeProjectId?: string;
  minImportance?: number;
  perProjectLimit?: number;
}

export const projectMemories = {
  async listAll(options: { excludeProjectId?: string; minImportance?: number; limit?: number } = {}): Promise<ProjectMemory[]> {
    const db = await getDb();
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (options.excludeProjectId) {
      params.push(options.excludeProjectId);
      clauses.push(`project_id != $${params.length}`);
    }
    if (options.minImportance !== undefined) {
      params.push(Math.max(0, options.minImportance));
      clauses.push(`importance >= $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = options.limit ? `LIMIT $${params.length + 1}` : "";
    if (options.limit) params.push(options.limit);
    const rows = await db.select<ProjectMemoryRow[]>(
      `SELECT * FROM project_memories ${where} ORDER BY importance DESC, updated_at DESC ${limitClause}`,
      params,
    );
    return rows.map(rowToProjectMemory);
  },

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
    options: SearchProjectMemoriesOptions = {},
  ): Promise<ProjectMemory[]> {
    const limit = options.limit ?? 10;
    const perProjectLimit = Math.max(1, options.perProjectLimit ?? 1);
    const minImportance = Math.max(0, options.minImportance ?? 0);
    const db = await getDb();
    const q = query.trim();
    if (!q) return [];
    // 拆词 + 任何一词命中都行（OR），按 importance + 命中数排
    const tokens = Array.from(new Set(q
      .split(/[\s,，、]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 1)
      .slice(0, 8)));
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
    const importanceClause = minImportance > 0
      ? `AND importance >= $${likeParams.length + 1}`
      : "";
    if (minImportance > 0) likeParams.push(minImportance);

    const sql = `
      SELECT pm.*, p.name AS project_name,
        (${likeConditions.map((c) => `CASE WHEN ${c} THEN 1 ELSE 0 END`).join(" + ")}) AS hits
      FROM project_memories pm
      LEFT JOIN projects p ON p.id = pm.project_id
      WHERE (${likeConditions.join(" OR ")})
      ${excludeClause}
      ${importanceClause}
      ORDER BY (importance / 100.0 + hits * 0.1) DESC, created_at DESC
      LIMIT $${likeParams.length + 1}
    `;
    likeParams.push(Math.max(limit * perProjectLimit, limit));
    const rows = await db.select<ProjectMemoryRow[]>(sql, likeParams);
    const picked = new Map<string, number>();
    const filtered: ProjectMemory[] = [];
    for (const row of rows) {
      const count = picked.get(row.project_id) ?? 0;
      if (count >= perProjectLimit) continue;
      filtered.push(rowToProjectMemory(row));
      picked.set(row.project_id, count + 1);
      if (filtered.length >= limit) break;
    }
    return filtered;
  },
};

export interface ProjectMemoryVector {
  memoryId: string;
  projectId: string;
  providerName: string;
  dim: number;
  embedding: number[];
  sourceHash: string;
  sourceUpdatedAt: string;
  indexedAt: string;
}

interface ProjectMemoryVectorRow {
  memory_id: string;
  project_id: string;
  provider_name: string;
  dim: number;
  embedding_json: string;
  source_hash: string;
  source_updated_at: string;
  indexed_at: string;
}

export interface ProjectMemoryVectorSearchRow extends ProjectMemory {
  providerName: string;
  dim: number;
  embedding: number[];
  sourceHash: string;
  sourceUpdatedAt: string;
  indexedAt: string;
}

function rowToProjectMemoryVector(r: ProjectMemoryVectorRow): ProjectMemoryVector {
  return {
    memoryId: r.memory_id,
    projectId: r.project_id,
    providerName: r.provider_name,
    dim: r.dim,
    embedding: JSON.parse(r.embedding_json),
    sourceHash: r.source_hash,
    sourceUpdatedAt: r.source_updated_at,
    indexedAt: r.indexed_at,
  };
}

export const projectMemoryVectors = {
  async get(memoryId: string, providerName: string): Promise<ProjectMemoryVector | null> {
    const db = await getDb();
    const rows = await db.select<ProjectMemoryVectorRow[]>(
      "SELECT * FROM project_memory_vectors WHERE memory_id = $1 AND provider_name = $2 LIMIT 1",
      [memoryId, providerName],
    );
    return rows[0] ? rowToProjectMemoryVector(rows[0]) : null;
  },

  async listByProvider(providerName: string): Promise<ProjectMemoryVector[]> {
    const db = await getDb();
    const rows = await db.select<ProjectMemoryVectorRow[]>(
      "SELECT * FROM project_memory_vectors WHERE provider_name = $1",
      [providerName],
    );
    return rows.map(rowToProjectMemoryVector);
  },

  async upsert(input: {
    memoryId: string;
    projectId: string;
    providerName: string;
    dim: number;
    embedding: number[];
    sourceHash: string;
    sourceUpdatedAt: string;
  }): Promise<void> {
    const db = await getDb();
    const ts = now();
    await db.execute(
      `INSERT INTO project_memory_vectors
        (memory_id, project_id, provider_name, dim, embedding_json, source_hash, source_updated_at, indexed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(memory_id, provider_name)
       DO UPDATE SET
         project_id = excluded.project_id,
         dim = excluded.dim,
         embedding_json = excluded.embedding_json,
         source_hash = excluded.source_hash,
         source_updated_at = excluded.source_updated_at,
         indexed_at = excluded.indexed_at`,
      [
        input.memoryId,
        input.projectId,
        input.providerName,
        input.dim,
        JSON.stringify(input.embedding),
        input.sourceHash,
        input.sourceUpdatedAt,
        ts,
      ],
    );
  },

  async listSearchRows(options: {
    providerName: string;
    excludeProjectId?: string;
    minImportance?: number;
  }): Promise<ProjectMemoryVectorSearchRow[]> {
    const db = await getDb();
    const params: unknown[] = [options.providerName];
    const clauses = ["pmv.provider_name = $1"];
    if (options.excludeProjectId) {
      params.push(options.excludeProjectId);
      clauses.push(`pm.project_id != $${params.length}`);
    }
    if (options.minImportance !== undefined) {
      params.push(Math.max(0, options.minImportance));
      clauses.push(`pm.importance >= $${params.length}`);
    }
    const rows = await db.select<Array<ProjectMemoryVectorRow & ProjectMemoryRow>>(
      `SELECT
          pm.id,
          pm.project_id,
          p.name AS project_name,
          pm.kind,
          pm.title,
          pm.content,
          pm.importance,
          pm.tags,
          pm.created_at,
          pm.updated_at,
          pmv.provider_name,
          pmv.dim,
          pmv.embedding_json,
          pmv.source_hash,
          pmv.source_updated_at,
          pmv.indexed_at,
          pmv.memory_id
       FROM project_memory_vectors pmv
       INNER JOIN project_memories pm ON pm.id = pmv.memory_id
       LEFT JOIN projects p ON p.id = pm.project_id
       WHERE ${clauses.join(" AND ")}`,
      params,
    );
    return rows.map((r) => ({
      ...rowToProjectMemory(r),
      providerName: r.provider_name,
      dim: r.dim,
      embedding: JSON.parse(r.embedding_json),
      sourceHash: r.source_hash,
      sourceUpdatedAt: r.source_updated_at,
      indexedAt: r.indexed_at,
    }));
  },
};
