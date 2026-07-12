/**
 * Scope 的 key 转换工具。
 *
 * Scope 在内存里是 discriminated union；落到 DB 必须变成两列字符串：
 *   scope_level ∈ { 'project', 'global', 'distribution' }
 *   scope_id    ∈ string（不含 NULL）
 *
 * global scope 在 DB 里用 sentinel 字符串 "__global__" 表达，
 * 避免 PK(NULL, NULL) 的 SQLite 边界问题（DAO 用普通 "=" 比较）。
 */

import type { PolicyScope } from "./types";

/** global scope 在 DB 里的 sentinel 值。 */
export const GLOBAL_SCOPE_ID = "__global__";

export type ScopeLevelLiteral = "project" | "global" | "distribution";

export interface ScopeKey {
  readonly level: ScopeLevelLiteral;
  readonly id: string;
}

export function scopeToKey(scope: PolicyScope): ScopeKey {
  switch (scope.level) {
    case "project":
      return { level: "project", id: scope.projectId };
    case "global":
      return { level: "global", id: GLOBAL_SCOPE_ID };
    case "distribution":
      return { level: "distribution", id: scope.channel };
  }
  // Exhaustiveness: discriminated union 三个 case 已全覆盖，这里只在 TS 编译器认错时兜底。
  throw new Error(`[policy/scope-key] unreachable scope: ${JSON.stringify(scope)}`);
}

/**
 * 把 DB 行反向解析回内存 Scope。
 *
 * review S-F-08（2026-07-13）修复：原版对未知 distribution channel 静默回退 stable，
 * 吞掉了 channel=garbage 这种"写入端出错"的信号。改：未知 channel 留下 console.warn
 * 标记 + 仍回退 stable（不能崩运行），但运维日后能凭日志追查。
 */
export function keyToScope(level: ScopeLevelLiteral, id: string): PolicyScope {
  switch (level) {
    case "project":
      return { level: "project", projectId: id };
    case "global":
      return { level: "global" };
    case "distribution":
      if (id === "dev" || id === "stable") {
        return { level: "distribution", channel: id };
      }
      // 兜底：未知 channel 不崩运行，但 console.warn 留痕，下次排查有据可查。
      console.warn(
        `[policy/scope-key] 未知 distribution channel "${id}"，回退到 "stable"。` +
        "通常是 DB 历史脏数据或写入端写错，请检查。",
      );
      return { level: "distribution", channel: "stable" };
  }
  throw new Error(`[policy/scope-key] unreachable level: ${level}`);
}
