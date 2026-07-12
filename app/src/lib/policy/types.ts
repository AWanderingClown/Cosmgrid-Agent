/**
 * 引擎化改造方案 §5.2：策略抽象层的类型契约。
 *
 * PolicyDefinition<T> 是每条策略在自己域文件里实现的接口；PolicyStore 只负责
 * CRUD + scope 调度，不解析 value——value 的 schema 校验是策略自己的责任。
 *
 * 合并语义两类：
 *   - union（白名单类）：生效 = builtin ∪ 用户新增（只增不减，安全）；例：command.allowed_programs
 *   - override（价格/评分/关键词表类）：生效 = override ?? builtin；
 *     例：provider.error_patterns / message-router markers / intent markers
 */

/**
 * 策略的 scope——策略覆盖生效的范围。
 *
 * K2 三档：
 *   - project：项目级覆盖，项目号 projectId；
 *   - global：全局覆盖（当前用户看到这台电脑的所有项目统一）；
 *   - distribution：发布/开发通道的内置参数，用户切不到这一档；
 *     P2 运营侧可调策略走这一档。
 */
export type PolicyScope =
  | { level: "project"; projectId: string }
  | { level: "global" }
  | { level: "distribution"; channel: "stable" | "dev" };

/** 策略的合并语义类别。 */
export type PolicyMergeKind = "union" | "override";

/**
 * 策略定义。每条策略在自己的域文件（例：command-allowlist.ts）里 export const XxxPolicy:
 * PolicyDefinition<Set<string>> = { ... }。
 */
export interface PolicyDefinition<T> {
  /** 稳定 key；建议 "domain.name" 风格（如 "command.allowed_programs"）。 */
  readonly key: string;

  /** 内置默认；永远存在的兜底底线，不能为空。 */
  readonly builtin: T;

  /** builtin 版本戳；用作 builtin 升级时提示用户的依据（§5.4 versioning）。 */
  readonly builtinVersion: string;

  /** 合并语义。 */
  readonly mergeKind: PolicyMergeKind;

  /**
   * 把 DB 里存的 value_json 解析成强类型 T。schema 不符抛 Error（一般是 z.ZodError）。
   * 由各策略自带——用 zod 实现 parse 是项目惯例（bash-tool.ts:14 同模式）。
   */
  parse(raw: string): T;

  /**
   * 把 builtin 和 override 合并成最终生效值。两种语义函数体一目了然：
   *   - union：    merge = (b, o) => new Set([...b, ...o])
   *   - override： merge = (_b, o) => o
   * 策略自己提供；PolicyStore 不僭越。
   */
  merge(builtin: T, override: T): T;

  /** 该策略允许写入的 scope level。例：union 白名单通常允许 project；价格表可能允许 global。 */
  readonly scopesAllowed: ReadonlyArray<PolicyScope["level"]>;
}

/**
 * scope 解析顺序（§5.2 K2）。
 * 越具体优先级越高，匹配规则：
 *   project > global > distribution
 * 调用方：policyStore.resolve(policyKey, projectId) → 沿顺序读三层 scope 找到第一个 override。
 */
export function scopePrecedence(): ReadonlyArray<PolicyScope["level"]> {
  return ["project", "global", "distribution"] as const;
}
