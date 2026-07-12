/**
 * 引擎化改造方案 §5.3 / 阶段 3 R7：敏感路径黑名单集中点。
 *
 * 原位置：src/lib/llm/tools/path-safety.ts:68-76
 * 安全底线，已通过 RESERVED_POLICY_KEYS['security.sensitive_paths'] 锁定。
 */

export const SENSITIVE_PATH_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.env(\.|$|\/)/,
  /(^|\/)secrets?\.[^/]+$/i,
  /(^|\/)keystore\.json$/,
  /(^|\/)id_rsa(\.|$)/,
]);

/** 命中任一 pattern → true。保留具名函数让原模块继续高内聚。 */
export function isSensitivePath(absPath: string): boolean {
  for (const re of SENSITIVE_PATH_PATTERNS) {
    if (re.test(absPath)) return true;
  }
  return false;
}
