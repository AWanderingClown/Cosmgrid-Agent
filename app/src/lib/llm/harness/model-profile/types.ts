// Harness 工程实施计划 阶段6 — 模型 Harness Profile 类型定义。
//
// ⚠️ 储备状态（2026-07-16 审查确认，非漏接的死代码，勿删）：
//   本模块（resolver / aggregator / apply）当前**未接入主链路**，是有意保留的前瞻储备。
//   不接线的根因：`model_harness_profiles` 表没有任何生产写入口（无 create/insert/upsert）
//   → 表永远空 → resolveModelHarnessProfile 永远返回 null，即使接线也是空转 no-op。
//   整个闭环 aggregate(弱点)→建议 event→写表→resolve→apply 依赖 eval 常态化产出数据，
//   但 eval 无 CI 只手动跑，闭环从没有起点。各处已有硬编码 model 判断
//   （output-budget / model-aware-compaction）覆盖了当前实际需求。
//   接线前置条件：eval harness 常态化跑并把 FailureKind 数据喂给 aggregator。
//
// 设计动机：阶段 1-5 让 Harness 有门控 / 工具结构化 / 证据链 / Eval 指标 / 上下文资产，
// 但"模型可以热插拔但不同模型有不同弱点"未解。阶段 6 引入模型专属 Harness Profile。
//
// 关键不变量（计划文件 §核心不变量）：
// - 用户上下文保持完全独立 —— profile 不写 project_memories
// - 模型删除后保留历史统计 —— profile 表**不 FK 到 models**
// - 第一版"只生成不启用" —— profile.enabled 默认 false
// - 永远不允许自动修改：权限 / 命令安全 / Keychain / Eval grader / held-out / 审计 / 迁移 runner
// - L11 边界：lib/llm/harness/model-profile 不允许反向依赖 pages/components 运行时

/** 10 类稳定 failure taxonomy（计划文件 §工作项 1）
 *  新增失败时，fromXxx 映射函数 + zod 校验。 */
export type FailureKind =
  | "no_tool_completion"        // A 档：声称做了但 0 工具调用
  | "partial_fabrication"       // B 档：声称具体结果但与证据矛盾
  | "invalid_tool_args"         // TOOL_INVALID_PARAMS
  | "repeated_tool_call"        // TOOL_DOOM_LOOP
  | "context_overflow"          // 上下文窗口耗尽
  | "premature_completion"      // finishReason 正常但 outcome failed/needs_user
  | "invalid_structured_output" // generateObject / Zod parse 失败
  | "rate_limit"                // 429 / 限流
  | "session_limit"             // CLI session 耗尽
  | "stale_context";            // 跨模型 handoff 状态不连续

/** 4 类 AdaptationRule（计划文件 §第一版允许优化的表面）
 *  显式禁止项在 rule schema 校验层 hard block（apply 层不修改 security / readOnly / parameters / commandSafety）。 */
export type AdaptationRule =
  | { kind: "skill_instruction"; content: string; tags: string[] }
  | { kind: "tool_description_override"; toolName: string; descriptionOverride: string }
  | { kind: "tool_result_format_hint"; templateKey: string; snippet: string }
  | { kind: "retry_policy_override"; maxRetries?: number; maxContextOverflowRetries?: number };

/** Profile 主表（model_harness_profiles） */
export interface ModelHarnessProfile {
  id: string;
  modelId: string | null;          // null = 匹配任意 modelId
  modelName: string;                // 用于 match 旧 model（按 display name）
  providerId: string | null;
  providerType: string | null;
  versionRange: string | null;      // ">=1.5,<2.0" 简单字符串
  harnessVersionMin: string | null;
  harnessVersionMax: string | null;
  enabled: boolean;                // 默认 false（用户必须显式批准）
  createdAt: string;
  updatedAt: string;
}

/** Profile 事件表（model_harness_profile_events） */
export interface ModelHarnessProfileEvent {
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
  failureId: string | null;        // 反查具体失败行
  confidence: number;              // 0-1
  applicableHarnessVersion: string | null;
  enabled: boolean;
  suggestedAt: string;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Resolved profile（每轮 chat 动态解析，不污染历史） */
export interface ResolvedModelHarnessProfile {
  profile: ModelHarnessProfile;
  events: ModelHarnessProfileEvent[];
  /** profile merge 后的最终 adaptation 集合（按 priority 排序） */
  mergedAdaptations: AdaptationRule[];
}

/** aggregator 输出（建议生成 profile 的依据） */
export interface WeaknessEntry {
  failureKind: FailureKind;
  frequency: number;        // 0-1
  confidence: number;       // 0-1
  sampleCount: number;
  suggestedAdaptation: AdaptationRule;
}

export interface WeaknessReport {
  modelId: string | null;
  modelName: string;
  generatedAt: string;
  entries: WeaknessEntry[];
  /** 已存在的 enabled event（避免重复建议） */
  existingEventKeys: Set<string>;
}