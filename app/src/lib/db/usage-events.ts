import { getDb } from "./connection";
import { boolToInt, newId, now } from "./utils";

// ============ usageEvents ============

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
