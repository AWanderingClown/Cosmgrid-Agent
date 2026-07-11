// Harness 工程实施计划 阶段6 — Profile Resolver（每轮 chat 动态解析）。
//
// `resolveModelHarnessProfile`：根据当前 model 信息 + harness_version 查 enabled profile，
// 再查该 profile 下的 enabled events（按 versionRange 过滤），按 priority 合并 adaptations。
//
// 关键不变量：
// - 没有 enabled profile 时返回 null（不报错）
// - profile 不写历史，不污染 user 上下文
// - 旁路 try/catch + console.error 降级

import { modelHarnessProfiles, modelHarnessProfileEvents } from "@/lib/db";
import type { AdaptationRule, ResolvedModelHarnessProfile } from "./types";

export interface ResolveModelHarnessProfileInput {
  modelId: string | null;
  modelName: string;
  providerId?: string | null;
  providerType?: string | null;
  modelVersion?: string | null;
  harnessVersion?: string | null;
}

export async function resolveModelHarnessProfile(
  input: ResolveModelHarnessProfileInput,
): Promise<ResolvedModelHarnessProfile | null> {
  try {
    const profiles = await modelHarnessProfiles.listMatching({
      modelId: input.modelId,
      modelName: input.modelName,
      providerId: input.providerId ?? null,
      providerType: input.providerType ?? null,
      modelVersion: input.modelVersion ?? null,
      harnessVersion: input.harnessVersion ?? null,
    });
    if (profiles.length === 0) return null;

    // 第一版取最新的一个 profile（多 profile 合并留阶段 7 Eval Harness 评分用）
    const profile = profiles[0]!;
    const events = await modelHarnessProfileEvents.listEnabledByProfile(
      profile.id,
      input.harnessVersion ?? null,
    );
    if (events.length === 0) return null;

    // 按 priority 排序：manual > eval > production
    const priority: Record<string, number> = { manual: 3, eval: 2, production: 1 };
    const sorted = [...events].sort((a, b) => {
      const pa = priority[a.sourceType] ?? 0;
      const pb = priority[b.sourceType] ?? 0;
      return pb - pa;
    });
    const mergedAdaptations: AdaptationRule[] = sorted.map((e) => e.adaptationRule);

    return { profile, events: sorted, mergedAdaptations };
  } catch (err) {
    // 旁路降级：解析失败不影响主对话流
    console.error(
      "[model-profile] resolveModelHarnessProfile 失败：",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
