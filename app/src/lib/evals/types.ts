// Harness 工程实施计划 阶段4 — Eval Harness 类型定义（pure types，无运行时）。
//
// 设计动机：阶段 1-3 已经让 Harness 有完整的门控 + 工具结构化 + 证据链（verifyNodeOutcome /
// ToolResultV2 / verifyTask），但**没量化**——我们不知道 Harness 真的"进步了"还是"只是在不同时刻
// 犯了不同的错"。阶段 4 用 11 个指标衡量整个 Harness，让每次改动都有量化对比。
//
// ID 空间：
// - EvalCase.id 与 EvalResult.taskId 用稳定字符串（fixture 文件名）
// - EvalRun.id 用 crypto.randomUUID（运行实例唯一）
// - TaskOutcome.conversationId 直接关联 conversation row



/** Eval 任务集分类 —— 计划文件 §评估集划分 */
export type TaskSetId = "held-in" | "held-out" | "manual";

/** Eval 权限配置（决定哪些工具可用） */
export type PermissionProfile =
  | "default"         // 全工具
  | "read-only"       // 只读工具（read/glob/grep/git_read）
  | "no-write"        // 禁止 write/edit
  | "full-trust";     // 跳过所有 confirm 弹窗

/** Eval 接受标准（可序列化的"任务完成"定义） */
export interface AcceptanceCriterion {
  /** grader 名（在 `graders/index.ts` 注册） */
  grader: string;
  /** grader 期望的具体值（每个 grader 自己解析） */
  expected: unknown;
}

export interface EvalCase {
  id: string;
  taskSetId: TaskSetId;
  name: string;
  /** 相对 app/ 工作区的 fixture 路径（如 "src/lib/evals/fixtures/held-in/foo.json"） */
  fixturePath: string;
  permissionProfile: PermissionProfile;
  /** 限定允许的模型（不传 = 全部） */
  allowedModels?: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  /** 单 case 预算上限（USD），超限 → 立即 fail + BUDGET_EXCEEDED */
  budgetUsd?: number;
  /** 单 case 超时（秒），超限 → 立即 fail + TIMEOUT */
  timeoutSeconds?: number;
  tags?: string[];
  createdAt: string;
}

/** 单次评估运行（harness_version 必填，否则"修复了什么"对比无锚点） */
export interface EvalRun {
  id: string;
  harnessVersion: string;
  modelId: string;
  taskSetId: TaskSetId;
  startedAt: string;
  finishedAt?: string;
  totalCostUsd: number;
  retryCount: number;
  status: "running" | "completed" | "aborted" | "timeout";
  /** run 关联的额外产物（log / 报告路径）JSON 序列化 */
  artifactJson?: string;
  /** 失败类型直方图 JSON 数组 [{kind: "TOOL_DENIED", count: 3}, ...] */
  failureKindsJson?: string;
  createdAt: string;
}

/** 单条用例结果（task × attempt 粒度） */
export interface EvalResult {
  id: string;
  runId: string;
  taskId: string;
  attemptIndex: number;
  /** null = inconclusive（LLM judge 失败 / grader 抛错 / 预算超限中途退出） */
  passed: boolean | null;
  attemptCostUsd: number;
  attemptLatencyMs: number;
  interventionsCount: number;
  failureCode?: string;
  /** 每个 grader 的详细输出 JSON 序列化 */
  gradedJson?: string;
  createdAt?: string;
}

/** 生产任务最终结果（被 stream-finalization 上报） */
export type TaskOutcomeValue =
  | "passed"
  | "failed"
  | "blocked"
  | "needs_user"
  | "retryable"
  | "cancelled";

export interface TaskOutcome {
  id: string;
  conversationId: string;
  nodeId?: string;
  outcome: TaskOutcomeValue;
  finalSummary?: string;
  interventionKind?: string;
  evidenceRefsJson?: string;
  createdAt: string;
}

/** EvalMetrics 聚合 11 个指标（来自计划文件 §核心指标） */
export interface EvalMetrics {
  /** 最终满足任务验收标准的比例 */
  completionRate: number;
  /** 第一次执行即通过 */
  passAt1: number;
  /** 三次允许尝试内通过 */
  passAt3: number;
  /** 独立验收通过率（verifyTask.status === "passes" 比例） */
  verifierPassRate: number;
  /** 防编造、伪工具、缺证据命中率（error_code !== null 比例） */
  harnessViolationRate: number;
  /** 每个任务平均重试次数 */
  retriesPerTask: number;
  /** 用户确认、纠正、重新说明次数（needs_user + blocked 计数） */
  humanInterventions: number;
  /** 失败、重启、换模型后的恢复成功率 */
  recoveryRate: number;
  /** 每个真正成功任务的成本（USD） */
  costPerSuccess: number;
  /** 每个真正成功任务的时间（ms） */
  latencyPerSuccess: number;
  /** 换模型/重启后无需重讲的比例 */
  contextContinuityRate: number;
}

/** 单次 attempt 上下文（grader 复用，Runner 编排） */
export interface GraderContext {
  caseId: string;
  workspacePath: string;
  conversationId?: string;
  /** 关联的 tool_executions（按 messageId 归属） */
  toolExecRows: import("@/lib/db").ToolExecutionRow[];
  /** 关联的 workflow_runs（按 conversationId 取最近） */
  workflowRun?: import("@/lib/db").EvalRunRow;
  /** 关联的 task_outcomes（按 conversationId 取） */
  taskOutcomes: import("@/lib/db").TaskOutcomeRow[];
  /** 上限：budget 已用 / budget 总数 */
  budgetUsedUsd: number;
  budgetTotalUsd: number;
}

export interface GraderResult {
  ok: boolean;
  detail: string;
  /** 失败时给 human 看的额外解释（多行） */
  extra?: string;
}

export type Grader = (
  expected: unknown,
  ctx: GraderContext,
) => Promise<GraderResult> | GraderResult;

/** EvalRunner 配置（CLI 入口 / test fixture） */
export interface RunnerConfig {
  taskSetId: TaskSetId;
  modelId: string;
  maxAttempts?: number;       // 默认 3
  budgetUsd?: number;        // 默认 5.0
  harnessVersion: string;
  judgeModel?: unknown;       // LanguageModel from "ai" —— type 保留灵活
  concurrency?: number;       // 默认 1
}