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
