// Harness 工程实施计划 阶段6 — model_harness_profiles + model_harness_profile_events DAO。
//
// 2 张新表（不 FK 到 models，模型删除后保留历史）：
// - model_harness_profiles：profile 主表（model_id nullable / model_name 必填 / enabled 默认 false）
// - model_harness_profile_events：每条 event 对应一个 FailureKind + AdaptationRule
//
// 默认 enabled=false —— 阶段6 策略："只生成不启用"，用户必须显式批准。

import { getDb } from "./connection";
import { newId, now } from "./utils";
import type { FailureKind, AdaptationRule } from "@/lib/llm/harness/model-profile/types";

// ============ model_harness_profiles ============

export interface ModelHarnessProfileRow {
  id: string;
  modelId: string | null;
  modelName: string;
  providerId: string | null;
  providerType: string | null;
  versionRange: string | null;
  harnessVersionMin: string | null;
  harnessVersionMax: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function mapProfileRow(r: any): ModelHarnessProfileRow {
  return {
    id: r.id,
    modelId: r.model_id,
    modelName: r.model_name,
    providerId: r.provider_id,
    providerType: r.provider_type,
    versionRange: r.version_range,
    harnessVersionMin: r.harness_version_min,
    harnessVersionMax: r.harness_version_max,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const modelHarnessProfiles = {
  async create(input: Omit<ModelHarnessProfileRow, "id" | "createdAt" | "updatedAt">): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO model_harness_profiles
        (id, model_id, model_name, provider_id, provider_type, version_range, harness_version_min, harness_version_max, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, input.modelId, input.modelName, input.providerId, input.providerType, input.versionRange,
        input.harnessVersionMin, input.harnessVersionMax, input.enabled ? 1 : 0, now(), now(),
      ],
    );
    return id;
  },

  async listEnabled(modelName: string): Promise<ModelHarnessProfileRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM model_harness_profiles WHERE model_name = $1 AND enabled = 1 ORDER BY created_at DESC",
      [modelName],
    );
    return rows.map(mapProfileRow);
  },

  async listMatching(input: {
    modelId: string | null;
    modelName: string;
    providerId?: string | null;
    providerType?: string | null;
    modelVersion?: string | null;
    harnessVersion?: string | null;
  }): Promise<ModelHarnessProfileRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM model_harness_profiles WHERE model_name = $1 AND enabled = 1 ORDER BY created_at DESC",
      [input.modelName],
    );
    return rows
      .map(mapProfileRow)
      .filter((profile) => profileMatchesRuntime(profile, input));
  },

  async listAllByModel(modelName: string): Promise<ModelHarnessProfileRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM model_harness_profiles WHERE model_name = $1 ORDER BY created_at DESC",
      [modelName],
    );
    return rows.map(mapProfileRow);
  },

  async updateEnabled(profileId: string, enabled: boolean): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE model_harness_profiles SET enabled = $1, updated_at = $2 WHERE id = $3",
      [enabled ? 1 : 0, now(), profileId],
    );
  },

  async getById(profileId: string): Promise<ModelHarnessProfileRow | null> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM model_harness_profiles WHERE id = $1 LIMIT 1",
      [profileId],
    );
    return rows.length > 0 ? mapProfileRow(rows[0]) : null;
  },
};

function profileMatchesRuntime(
  profile: ModelHarnessProfileRow,
  input: {
    modelId: string | null;
    providerId?: string | null;
    providerType?: string | null;
    modelVersion?: string | null;
    harnessVersion?: string | null;
  },
): boolean {
  if (profile.modelId && profile.modelId !== input.modelId) return false;
  if (profile.providerId && profile.providerId !== (input.providerId ?? null)) return false;
  if (profile.providerType && profile.providerType !== (input.providerType ?? null)) return false;
  if (!isApplicableHarnessVersion(profile.versionRange, input.modelVersion ?? null)) return false;
  if (profile.harnessVersionMin && !input.harnessVersion) return false;
  if (profile.harnessVersionMax && !input.harnessVersion) return false;
  if (profile.harnessVersionMin && compareVersion(input.harnessVersion!, profile.harnessVersionMin) < 0) return false;
  if (profile.harnessVersionMax && compareVersion(input.harnessVersion!, profile.harnessVersionMax) > 0) return false;
  return true;
}

// ============ model_harness_profile_events ============

export interface ModelHarnessProfileEventRow {
  id: string;
  profileId: string;
  modelId: string | null;
  modelName: string;
  providerType: string | null;
  failureKind: FailureKind;
  adaptationRule: AdaptationRule;
  sourceType: "eval" | "production" | "manual";
  sourceEvalRunId: string | null;
  sourceEvalResultId: string | null;
  sourceUsageEventId: string | null;
  sourceTaskOutcomeId: string | null;
  sourceToolExecutionId: string | null;
  failureId: string | null;
  confidence: number;
  applicableHarnessVersion: string | null;
  enabled: boolean;
  suggestedAt: string;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapEventRow(r: any): ModelHarnessProfileEventRow {
  return {
    id: r.id,
    profileId: r.profile_id,
    modelId: r.model_id,
    modelName: r.model_name,
    providerType: r.provider_type,
    failureKind: r.failure_kind,
    adaptationRule: JSON.parse(r.adaptation_rule_json),
    sourceType: r.source_type,
    sourceEvalRunId: r.source_eval_run_id,
    sourceEvalResultId: r.source_eval_result_id,
    sourceUsageEventId: r.source_usage_event_id,
    sourceTaskOutcomeId: r.source_task_outcome_id,
    sourceToolExecutionId: r.source_tool_execution_id,
    failureId: r.failure_id,
    confidence: r.confidence,
    applicableHarnessVersion: r.applicable_harness_version,
    enabled: !!r.enabled,
    suggestedAt: r.suggested_at,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const modelHarnessProfileEvents = {
  async create(input: Omit<ModelHarnessProfileEventRow, "id" | "createdAt" | "updatedAt">): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO model_harness_profile_events
        (id, profile_id, model_id, model_name, provider_type, failure_kind, adaptation_rule_json, source_type,
         source_eval_run_id, source_eval_result_id, source_usage_event_id, source_task_outcome_id, source_tool_execution_id,
         failure_id, confidence, applicable_harness_version, enabled, suggested_at, approved_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        id, input.profileId, input.modelId, input.modelName, input.providerType, input.failureKind,
        JSON.stringify(input.adaptationRule), input.sourceType,
        input.sourceEvalRunId, input.sourceEvalResultId, input.sourceUsageEventId, input.sourceTaskOutcomeId,
        input.sourceToolExecutionId, input.failureId, input.confidence, input.applicableHarnessVersion,
        input.enabled ? 1 : 0, input.suggestedAt, input.approvedAt, now(), now(),
      ],
    );
    return id;
  },

  async listEnabledByProfile(profileId: string, harnessVersion: string | null): Promise<ModelHarnessProfileEventRow[]> {
    const db = await getDb();
    // 简单 versionRange 过滤：先全查 enabled，再在内存里做"version in range"判断
    // （version 字符串格式 ">=1.5,<2.0"，第一版用半区间简单处理）
    const rows = await db.select<any[]>(
      "SELECT * FROM model_harness_profile_events WHERE profile_id = $1 AND enabled = 1 ORDER BY created_at ASC",
      [profileId],
    );
    return rows
      .map(mapEventRow)
      .filter((evt) => isApplicableHarnessVersion(evt.applicableHarnessVersion, harnessVersion));
  },

  async listEnabledByFailureKind(failureKind: FailureKind, modelName: string): Promise<ModelHarnessProfileEventRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      `SELECT e.* FROM model_harness_profile_events e
       JOIN model_harness_profiles p ON p.id = e.profile_id
       WHERE e.failure_kind = $1 AND e.enabled = 1 AND p.enabled = 1 AND p.model_name = $2
       ORDER BY e.created_at DESC`,
      [failureKind, modelName],
    );
    return rows.map(mapEventRow);
  },
};

/** 简单 version in range 判定（plan §D 步骤 2） */
function isApplicableHarnessVersion(range: string | null, current: string | null): boolean {
  if (!range) return true; // 没设范围 = 适用所有
  if (!current) return false; // 设了范围但当前没版本 = 跳过
  // 极简实现：只支持 ">=X" / "<=X" / 单值相等
  const parts = range.split(",").map((p) => p.trim());
  for (const p of parts) {
    if (p.startsWith(">=")) {
      if (compareVersion(current, p.slice(2)) < 0) return false;
      continue;
    }
    if (p.startsWith("<=")) {
      if (compareVersion(current, p.slice(2)) > 0) return false;
      continue;
    }
    if (p.startsWith(">")) {
      if (compareVersion(current, p.slice(1)) <= 0) return false;
      continue;
    }
    if (p.startsWith("<")) {
      if (compareVersion(current, p.slice(1)) >= 0) return false;
      continue;
    }
    if (p !== current) return false;
  }
  return true;
}

function compareVersion(a: string, b: string): number {
  const aa = a.split(".").map((part) => Number.parseInt(part, 10));
  const bb = b.split(".").map((part) => Number.parseInt(part, 10));
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const av = Number.isFinite(aa[i]) ? aa[i]! : 0;
    const bv = Number.isFinite(bb[i]) ? bb[i]! : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
