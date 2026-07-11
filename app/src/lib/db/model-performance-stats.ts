import { getDb } from "./connection";
import { newId, now } from "./utils";

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
  /** 阶段6 新增 4 类独立指标（计划文件 §步骤 F） */
  transportSuccessRate: number;
  taskSuccessRate: number;
  verifierPassRate: number;
  costPerSuccess: number;
  failureCountByKindJson: string;
}

type ModelPerformanceStatUpsertInput =
  Omit<ModelPerformanceStatRow, "transportSuccessRate" | "taskSuccessRate" | "verifierPassRate" | "costPerSuccess" | "failureCountByKindJson"> &
  Partial<Pick<ModelPerformanceStatRow, "transportSuccessRate" | "taskSuccessRate" | "verifierPassRate" | "costPerSuccess" | "failureCountByKindJson">>;

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
    transportSuccessRate: r.transport_success_rate ?? r.success_rate,
    taskSuccessRate: r.task_success_rate ?? r.success_rate,
    verifierPassRate: r.verifier_pass_rate ?? r.success_rate,
    costPerSuccess: r.cost_per_success ?? 0,
    failureCountByKindJson: r.failure_count_by_kind_json ?? "{}",
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
  async upsert(stat: ModelPerformanceStatUpsertInput): Promise<void> {
    const db = await getDb();
    const ts = now();
    const transportSuccessRate = stat.transportSuccessRate ?? stat.successRate;
    const taskSuccessRate = stat.taskSuccessRate ?? stat.successRate;
    const verifierPassRate = stat.verifierPassRate ?? stat.successRate;
    const costPerSuccess = stat.costPerSuccess ?? (stat.successRate > 0 ? stat.avgCost / stat.successRate : 0);
    const failureCountByKindJson = stat.failureCountByKindJson ?? "{}";
    await db.execute(
      `INSERT INTO model_performance_stats
        (id, model_id, task_type, success_rate, avg_input_tokens, avg_output_tokens,
         avg_cost, avg_latency_ms, sample_count, window_start, window_end,
         transport_success_rate, task_success_rate, verifier_pass_rate, cost_per_success, failure_count_by_kind_json,
         updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT(model_id, task_type) DO UPDATE SET
         success_rate = excluded.success_rate,
         avg_input_tokens = excluded.avg_input_tokens,
         avg_output_tokens = excluded.avg_output_tokens,
         avg_cost = excluded.avg_cost,
         avg_latency_ms = excluded.avg_latency_ms,
         sample_count = excluded.sample_count,
         window_start = excluded.window_start,
         window_end = excluded.window_end,
         transport_success_rate = excluded.transport_success_rate,
         task_success_rate = excluded.task_success_rate,
         verifier_pass_rate = excluded.verifier_pass_rate,
         cost_per_success = excluded.cost_per_success,
         failure_count_by_kind_json = excluded.failure_count_by_kind_json,
         updated_at = excluded.updated_at`,
      [
        newId(), stat.modelId, stat.taskType, stat.successRate, stat.avgInputTokens,
        stat.avgOutputTokens, stat.avgCost, stat.avgLatencyMs, stat.sampleCount,
        stat.windowStart, stat.windowEnd,
        transportSuccessRate, taskSuccessRate, verifierPassRate,
        costPerSuccess, failureCountByKindJson, ts,
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
