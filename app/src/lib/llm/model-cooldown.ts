// 模型 cooldown 熔断（v0.4.1 运行时回退链）
// 防止对一个刚失败的模型反复重试——失败次数越多，cooldown 越长
//
// 规则（窗口内连续失败 N 次）：
//   1 次失败 → 1 分钟冷却
//   2 次连续 → 5 分钟冷却
//   3+ 次连续 → 30 分钟冷却
// 成功一次就清空
//
// 为什么这样：用户最痛的是"卡在某个坏模型上一直重试"，先快速熔断让 fallback 有机会接管；
// 30 分钟是兜底——真要是模型下线了也不会频繁打扰。

import { modelCooldowns } from "@/lib/db/model-cooldowns";

const COOLDOWN_MS = [60_000, 300_000, 1_800_000]; // 1m / 5m / 30m

interface CooldownState {
  failures: number; // 连续失败次数（成功后清零）
  cooldownUntil: number | null; // epoch ms
}

const state = new Map<string, CooldownState>();

function persist(modelId: string, next: CooldownState): void {
  void modelCooldowns.upsert({
    modelId,
    failures: next.failures,
    cooldownUntil: next.cooldownUntil === null ? null : new Date(next.cooldownUntil).toISOString(),
  }).catch(() => {});
}

function clearPersisted(modelId: string): void {
  void modelCooldowns.clear(modelId).catch(() => {});
}

export async function hydrateModelCooldowns(modelIds: readonly string[]): Promise<void> {
  const rows = await modelCooldowns.listByModelIds(modelIds);
  const now = Date.now();
  for (const row of rows) {
    const cooldownUntil = row.cooldownUntil ? Date.parse(row.cooldownUntil) : null;
    if (cooldownUntil !== null && Number.isFinite(cooldownUntil) && cooldownUntil > now) {
      state.set(row.modelId, { failures: row.failures, cooldownUntil });
    } else {
      state.delete(row.modelId);
      clearPersisted(row.modelId);
    }
  }
}

/** 当前是否处于冷却中（true = 跳过这个模型）。过期顺便清理 */
export function isInCooldown(modelId: string): boolean {
  const s = state.get(modelId);
  if (!s || s.cooldownUntil === null) return false;
  if (Date.now() >= s.cooldownUntil) {
    state.delete(modelId);
    clearPersisted(modelId);
    return false;
  }
  return true;
}

/** 记录一次失败，下一次失败冷却时间会更长 */
export function markModelFailed(modelId: string): void {
  const prev = state.get(modelId) ?? { failures: 0, cooldownUntil: null };
  const nextFailures = prev.failures + 1;
  const idx = Math.min(nextFailures - 1, COOLDOWN_MS.length - 1);
  state.set(modelId, {
    failures: nextFailures,
    cooldownUntil: Date.now() + COOLDOWN_MS[idx]!,
  });
  persist(modelId, state.get(modelId)!);
}

/** 成功一次 → 清空该模型的失败计数 */
export function markModelSucceeded(modelId: string): void {
  state.delete(modelId);
  clearPersisted(modelId);
}

/** 距冷却结束还剩多少毫秒（不在冷却中 / 已过期 → 0）。给"全员冷却"报错拼出"还需 N 分钟"用。 */
export function getCooldownRemainingMs(modelId: string): number {
  const s = state.get(modelId);
  if (!s || s.cooldownUntil === null) return 0;
  return Math.max(0, s.cooldownUntil - Date.now());
}

/** 单测用：清空所有 cooldown 状态 */
export function _resetCooldowns(): void {
  state.clear();
}
