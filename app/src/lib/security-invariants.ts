/**
 * 安全底线常量与禁止运行时覆盖的 policy key 集中表。
 *
 * 本文件承载两类内容：
 *   1. RESERVED_POLICY_KEYS：被运行时 PolicyStore 拒绝写入的 key 名单。
 *      这些 key 对应的策略（安全红线）只能走源码审查 + 重新发版修改，
 *      不允许被 DB 数据覆盖——因为一旦允许，黑名单就能被手滑或被诱导改弱，
 *      绕过危险命令拦截、SSRF 防护、密钥脱敏等安全姿态。
 *   2. （阶段 3 R7 落地）安全常量物理搬迁的集中点。
 *      当前阶段此处仍只列 key 清单；阶段 3 才真正把 DANGEROUS_PATTERNS、敏感路径、
 *      SSRF host 名单、API_KEY_PATTERNS 等常量从各业务模块抽到这里集中维护。
 *
 * 维护原则：
 *   - 想加入新 RESERVED key → 在 PR 描述里点明"为什么这条策略不允许运行时覆盖"。
 *   - 业务模块禁止自己 export 一份禁写名单绕过本表（K6 强制集中）。
 *
 * 文档：Cosmgrid-Agent-引擎化改造方案 §5.3 §5.2
 */

export const RESERVED_POLICY_KEYS: ReadonlyArray<string> = Object.freeze([
  // —— 安全红线：黑名单类策略，黑名单可被覆盖 = 打开后门，禁止 ——
  "security.dangerous_patterns",
  "security.sensitive_paths",
  "security.ssrf_hosts",
  "security.api_key_patterns",

  // —— 安全相关 UX-only 标记：当前 §4.2 明确"不应引擎化"，但需要登记防止
  // 未来 PR 顺手把它们以同名 policy key 接 PolicyStore。READONLY_PROGRAMS /
  // GIT_READONLY_SUBCOMMANDS 决定"是否免二次确认"——可被运行时覆盖 = 静默失效。
  // 这里登记不是要支持覆盖，是给"防止将来误接"加一个明确的禁入信号。
  "security.readonly_programs",
  "security.git_readonly_subcommands",

  // —— 黑名单被锁的对称面：白名单虽然允许 union 累加，但保留把 builtin 完整保护起来 ——
  // 当前仅作占位；白名单 builtin 已通过 PolicyDefinition.builtin 自然落地，此处不重复。
]);

/**
 * 检查一个 policy key 是否属于禁止运行时覆盖的保留 key。
 * PolicyStore.set() 在写入前调用此函数，命中即抛出 RESERVED_KEY 错误。
 */
export function isReservedPolicyKey(policyKey: string): boolean {
  return RESERVED_POLICY_KEYS.includes(policyKey);
}
