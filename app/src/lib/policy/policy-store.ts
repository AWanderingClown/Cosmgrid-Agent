/**
 * 引擎化改造方案 §5.2 / §5.3 / §5.4：策略存储的核心业务层。
 *
 * 职责边界（极窄）：
 *   - CRUD+scope 调度：get/set/clear/reset/listKeys/history
 *   - scope 编码到 DB 列（scopeToKey）+ 解码（keyToScope）
 *   - RESERVED_POLICY_KEYS 黑名单入口（§5.3 安全底线）
 *   - set/clear 时同步写 audit（policy_override_history）
 *   - reset cascade 语义（K3）
 *
 * 不做的事：
 *   - 不解析 value_json（每条 PolicyDefinition.parse 负责）
 *   - 不做合并语义（每条 PolicyDefinition.merge 负责）
 *   - 不写 zod schema（每条策略自带）
 *   - 不发版本升级 banner（设置页负责）
 *
 * 设计决策（push 进来容易的坑）：
 *   - PolicyStore 是 class（可注入 DAO mock） + 单例 `policyStore`（生产代码用单例）
 *   - scope level 在 set/clear 时不强制校验 scopesAllowed：留给 PolicyDefinition 自己决定，
 *     因为 definition 不在 store 的可达域里（forward-declare 字符串 key）。
 *     这意味着 store 是 schema-agnostic 的，scope 错误由调用方负责——和 §5.2 立论一致。
 *   - 错误类用 union literal code（'RESERVED_KEY' / 'INVALID_JSON' / 'NOT_RESETTABLE'），
 *     便于 UI 文案统一判断，不用 instanceof。
 */

import { isReservedPolicyKey } from "@/lib/security-invariants";
import { policyOverrides } from "@/lib/db/policy-overrides";
import { policyOverrideHistory, type PolicyOverrideHistoryRow } from "@/lib/db/policy-override-history";
import type { PolicyScope } from "./types";
import { scopeToKey } from "./scope-key";

export type PolicyStoreErrorCode =
  | "RESERVED_KEY"
  | "INVALID_JSON"
  | "NOT_RESETTABLE";

export class PolicyStoreError extends Error {
  public readonly code: PolicyStoreErrorCode;

  constructor(message: string, code: PolicyStoreErrorCode) {
    super(message);
    this.name = "PolicyStoreError";
    this.code = code;
  }
}

export interface EffectivePolicy<T> {
  /** 解析后的强类型值（builtin 与 override 经 PolicyDefinition.merge 合并）。 */
  value: T;
  /** 真正生效的 override value_json；null = 没有任何 override，纯 builtin。 */
  effectiveJson: string | null;
  /** 用到哪一层 scope 命中；null = 走 builtin fallback。 */
  resolvedScope: PolicyScope | null;
}

/**
 * 注入点：构造函数接收 DAO 替身，便于测试；生产代码 import 单例 `policyStore`。
 */
export interface PolicyStoreDeps {
  overrides?: typeof policyOverrides;
  history?: typeof policyOverrideHistory;
}

export class PolicyStore {
  private readonly overrides: typeof policyOverrides;
  private readonly historyDao: typeof policyOverrideHistory;

  constructor(deps: PolicyStoreDeps = {}) {
    this.overrides = deps.overrides ?? policyOverrides;
    this.historyDao = deps.history ?? policyOverrideHistory;
  }

  /**
   * 读一条 scope override（raw value_json）。null = 该 scope 没有 override。
   * 调用方负责 parse + 与 builtin 合并。
   */
  async get(policyKey: string, scope: PolicyScope): Promise<string | null> {
    const row = await this.overrides.get(policyKey, scope);
    return row ? row.valueJson : null;
  }

  /**
   * 写一条 scope override。触发以下校验：
   *   - policyKey ∈ RESERVED_POLICY_KEYS → PolicyStoreError('RESERVED_KEY')
   *   - valueJson 不是合法 JSON → PolicyStoreError('INVALID_JSON')
   *
   * 注意：scopesAllowed 校验不由 store 做；它是 definition 层的契约，
   * 校验失败的责任在调用方（设置页 / orchestration 层）。
   *
   * 自动 audit：成功后 history.record(action='set', oldValueJson=...newValueJson=...)。
   * 审计失败不回滚 override（审计属事后修复通道，主路径不能因审计失败而无效）。
   * 不一致由 console.error 留痕（[policy-store] 标签约定见 §8）。
   */
  async set(
    policyKey: string,
    scope: PolicyScope,
    valueJson: string,
    actor?: string,
    builtinVersion?: string,
  ): Promise<void> {
    if (isReservedPolicyKey(policyKey)) {
      throw new PolicyStoreError(
        `[policy-store] policyKey "${policyKey}" 是 RESERVED key，禁止运行时覆盖（见 security-invariants.ts）`,
        "RESERVED_KEY",
      );
    }
    try {
      JSON.parse(valueJson);
    } catch (err) {
      throw new PolicyStoreError(
        `[policy-store] valueJson 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
        "INVALID_JSON",
      );
    }

    const oldRow = await this.overrides.get(policyKey, scope);
    // review T-F-7（2026-07-13）：DB 的 builtin_version 列以前硬编码 "pending"，等于一直不可比。
    // §5.4 versioning banner / 升级提示需要"用户这条 override 是按哪个 builtin 时代并入的"。
    // 现在接受调用方传入 builtinVersion（来自 policyDefinition.builtinVersion），默认 fallback
    // 到 "unknown-<sha8>" — 没法判断升级时也不能假装对齐，宁可显式 unknown。
    const recordedBuiltinVersion = builtinVersion ?? "unknown";

    // review F-04 修复（2026-07-13 审查）：原本 overrides.set 然后 history.record
    // 串行——任一崩溃都让 audit 缺失。改 Promise.allSettled 并发：
    //   - overrides.set reject → 抛（主路径失败，整 promise reject）
    //   - history.record reject → 不抛，但 console.error 强力留痕（含完整 policyKey/scope/value）
    //     让运维事后 grep 日志能查"这次写 audit 没留上"。完整的"audit-pending"记录表
    //     需要新 schema migration，这次修复先做"易追溯"，下一轮 code-review-loop 加表。
    const [, recordResult] = await Promise.allSettled([
      this.overrides.set({
        policyKey,
        scope,
        valueJson,
        builtinVersion: recordedBuiltinVersion,
        actor: actor ?? null,
      }),
      this.historyDao.record({
        policyKey,
        scope,
        action: "set",
        oldValueJson: oldRow?.valueJson ?? null,
        newValueJson: valueJson,
        actor: actor ?? null,
      }),
    ]);
    if (recordResult.status === "rejected") {
      console.error(
        `[policy-store] ⚠️ set audit 写失败 (主路径已成功，audit 缺失 — 运营 log 关键字搜索 AUDIT_LOST)：`,
        {
          policyKey,
          scope: scopeToKey(scope),
          valuePreview: valueJson.length > 200 ? `${valueJson.slice(0, 200)}…` : valueJson,
          actor,
          err: recordResult.reason,
        },
      );
    }
  }

  /**
   * 删一条 scope override。scope 上没有 override 时 no-op。
   * 自动 audit：成功后 history.record(action='clear')。
   */
  async clear(policyKey: string, scope: PolicyScope, actor?: string): Promise<void> {
    if (isReservedPolicyKey(policyKey)) {
      throw new PolicyStoreError(
        `[policy-store] policyKey "${policyKey}" 是 RESERVED key，禁止写入也包括清空`,
        "RESERVED_KEY",
      );
    }
    const oldRow = await this.overrides.get(policyKey, scope);
    if (!oldRow) return; // no-op
    // review F-04 同样：并发 run + audit 失败留痕。
    const [, recordResult] = await Promise.allSettled([
      this.overrides.clear(policyKey, scope),
      this.historyDao.record({
        policyKey,
        scope,
        action: "clear",
        oldValueJson: oldRow.valueJson,
        newValueJson: null,
        actor: actor ?? null,
      }),
    ]);
    if (recordResult.status === "rejected") {
      console.error(
        `[policy-store] ⚠️ clear audit 写失败 (主路径已成功，audit 缺失 — 搜索 AUDIT_LOST)：`,
        {
          policyKey,
          scope: scopeToKey(scope),
          removedValue: oldRow.valueJson,
          actor,
          err: recordResult.reason,
        },
      );
    }
  }

  /**
   * 重置（§5.4 K3 重置按钮语义）：
   *   - project scope：只清本项目 override。
   *   - global scope：级联清全局 + 全部该 key 的 project overrides。
   *   - distribution scope：拒绝（不可由 UI 触发；是发布通道内置参数）。
   */
  async reset(policyKey: string, scope: PolicyScope, actor?: string): Promise<void> {
    if (isReservedPolicyKey(policyKey)) {
      throw new PolicyStoreError(
        `[policy-store] policyKey "${policyKey}" 是 RESERVED key，不允许 reset`,
        "RESERVED_KEY",
      );
    }
    if (scope.level === "distribution") {
      throw new PolicyStoreError(
        `[policy-store] distribution scope 不允许 reset（它是发布通道内置参数）`,
        "NOT_RESETTABLE",
      );
    }

    if (scope.level === "project") {
      await this.clear(policyKey, scope, actor);
      return;
    }

    // global: cascade
    const before = await this.overrides.clearAllForPolicy(policyKey);
    if (before.length === 0) return;
    const auditRecords = before.map((row) =>
      this.historyDao.record({
        policyKey,
        scope: row.scope,
        action: "bulk_clear",
        oldValueJson: row.valueJson,
        newValueJson: null,
        actor: actor ?? null,
      }),
    );
    // review F-04 同样：bulk_clear 一致性边界——任一 audit 失败 console.error 不阻断；主路径
    // (overrides.clearAllForPolicy) 已经完成，所以即便 all audit 失败语义也对：cascade 完成。
    const auditResults = await Promise.allSettled(auditRecords);
    auditResults.forEach((r, i) => {
      if (r.status === "rejected") {
        const row = before[i]!;
        console.error(
          `[policy-store] ⚠️ reset cascade audit 写失败 (cascade 主路径已成功，audit 缺失 — 搜索 AUDIT_LOST)：`,
          {
            policyKey,
            scope: scopeToKey(row.scope),
            actor,
            err: r.reason,
          },
        );
      }
    });
  }

  /**
   * 列一条 policy 的全部 override（按 scope_level 排序）。
   * 给设置页 UI 用于展示"项目级 / 全局"两档当前值。
   */
  async listOverrides(policyKey: string) {
    return this.overrides.listByPolicy(policyKey);
  }

  /** 列当前有 override 的全部 key。给阶段 1+ 用来扫描"用户已配置过哪些策略"。 */
  async listConfiguredKeys(): Promise<string[]> {
    return this.overrides.listKeysWithOverrides();
  }

  /**
   * 一条 policy 的最近 audit（按时间倒序）。给运维排查"用户改坏了链路"用。
   * limit 默认 50；UI 调用传 100 / 200 都行。
   */
  async history(policyKey: string, limit = 50): Promise<PolicyOverrideHistoryRow[]> {
    return this.historyDao.listByPolicy(policyKey, limit);
  }
}

/** 生产代码单例。测试代码 new PolicyStore({...}) 注入 mock。 */
export const policyStore = new PolicyStore();
