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
