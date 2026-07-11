// Harness 工程实施计划 阶段4 — EvalMetrics 聚合（11 个指标的纯函数）。
//
// 设计原则：所有指标都是纯函数，输入 EvalResult[] + 过滤条件，输出 EvalMetrics。
// 不允许 IO / DB 调用（输入数据由 caller 提供）——保证单测易写、行为可预测。
//
// 指标语义（来自计划文件 §核心指标）：
// - completion_rate：所有 attempt 都跑完（不抛错）+ 至少一次 passed / 总 case 数
// - pass_at_1：case.attemptIndex === 0 且 passed === true 的比例
// - pass_at_3：case 任意 attempt passed === true 的比例
// - verifier_pass_rate：passed === true 的 attempt / 总 attempt 数（不含 null）
// - harness_violation_rate：failureCode 非空 + 包含 TOOL_* / 缺证据等关键词的 attempt / 总 attempt 数
// - retries_per_task：每个 case 的 attempt 数均值
// - human_interventions：failureCode 含 needs_user / blocked 的 attempt 数
// - recovery_rate：failureCode 含 retryable 但最终 attempt 任意一次 passed=true 的 case 比例
// - cost_per_success：所有 passed=true 的 attempt 之 cost 之和 / passed=true 的 attempt 数
// - latency_per_success：所有 passed=true 的 attempt 之 latency 之和 / passed=true 的 attempt 数
// - context_continuity_rate：failureCode 含 CONTEXT_LOST 的 case 比例（从 0 = 最好）

import type { EvalMetrics, EvalResult } from "./types";

/** groupByCase: 把同一 case 的多 attempt 聚到一起 */
function groupByCase(attempts: EvalResult[]): Map<string, EvalResult[]> {
  const out = new Map<string, EvalResult[]>();
  for (const a of attempts) {
    const list = out.get(a.taskId) ?? [];
    list.push(a);
    out.set(a.taskId, list);
  }
  // 每个 case 的 attempt 按 attemptIndex 排序
  for (const list of out.values()) list.sort((a, b) => a.attemptIndex - b.attemptIndex);
  return out;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

const HARNESS_VIOLATION_KEYWORDS = ["TOOL_", "EVIDENCE", "FABRICATION", "PSEUDO", "HARNESS"];

function isHarnessViolation(failureCode: string | undefined): boolean {
  if (!failureCode) return false;
  return HARNESS_VIOLATION_KEYWORDS.some((k) => failureCode.includes(k));
}

function isHumanIntervention(failureCode: string | undefined): boolean {
  if (!failureCode) return false;
  return failureCode === "needs_user" || failureCode === "blocked" || failureCode.includes("USER");
}

function isContextLoss(failureCode: string | undefined): boolean {
  return failureCode === "CONTEXT_LOST";
}

export function aggregateEvalMetrics(attempts: EvalResult[]): EvalMetrics {
  const groups = groupByCase(attempts);
  const totalCases = groups.size;
  if (totalCases === 0) {
    return zeroMetrics();
  }

  // 每个 case 的 attempt 列表
  const caseAttempts = [...groups.values()];

  // 通过的 case（任意 attempt passed=true）
  const passedCases = caseAttempts.filter((attempts) => attempts.some((a) => a.passed === true));
  const completionRate = passedCases.length / totalCases;

  // pass_at_1：attempt 0 成功
  const firstAttemptPassed = caseAttempts.filter((a) => a[0]?.passed === true);
  const passAt1 = firstAttemptPassed.length / totalCases;

  // pass_at_3：任意 attempt 成功
  const passAt3 = passedCases.length / totalCases;

  // verifier_pass_rate：attempt 级别，passed=true / (passed !== null)
  const determinateAttempts = attempts.filter((a) => a.passed !== null);
  const verifierPassRate = determinateAttempts.length === 0
    ? 0
    : determinateAttempts.filter((a) => a.passed === true).length / determinateAttempts.length;

  // harness_violation_rate：failureCode 关键词
  const violationCount = attempts.filter((a) => isHarnessViolation(a.failureCode)).length;
  const harnessViolationRate = attempts.length === 0 ? 0 : violationCount / attempts.length;

  // retries_per_task
  const retriesPerTask = mean(caseAttempts.map((a) => a.length));

  // human_interventions
  const humanInterventions = attempts.filter((a) => isHumanIntervention(a.failureCode)).length;

  // recovery_rate：failureCode 含 retryable 但任意 attempt 成功
  const retryablePassed = caseAttempts.filter((a) =>
    a.some((x) => x.failureCode === "retryable") && a.some((x) => x.passed === true),
  ).length;
  const retryableTotal = caseAttempts.filter((a) => a.some((x) => x.failureCode === "retryable")).length;
  const recoveryRate = retryableTotal === 0 ? 1 : retryablePassed / retryableTotal;

  // cost_per_success
  const passedAttempts = attempts.filter((a) => a.passed === true);
  const costPerSuccess = passedAttempts.length === 0
    ? 0
    : passedAttempts.reduce((s, a) => s + a.attemptCostUsd, 0) / passedAttempts.length;

  // latency_per_success
  const latencyPerSuccess = passedAttempts.length === 0
    ? 0
    : passedAttempts.reduce((s, a) => s + a.attemptLatencyMs, 0) / passedAttempts.length;

  // context_continuity_rate：context_loss 越少越好 → 1 - 比例
  const contextLossCount = caseAttempts.filter((a) => a.some((x) => isContextLoss(x.failureCode))).length;
  const contextContinuityRate = 1 - contextLossCount / totalCases;

  return {
    completionRate,
    passAt1,
    passAt3,
    verifierPassRate,
    harnessViolationRate,
    retriesPerTask,
    humanInterventions,
    recoveryRate,
    costPerSuccess,
    latencyPerSuccess,
    contextContinuityRate,
  };
}

function zeroMetrics(): EvalMetrics {
  return {
    completionRate: 0, passAt1: 0, passAt3: 0, verifierPassRate: 0,
    harnessViolationRate: 0, retriesPerTask: 0, humanInterventions: 0,
    recoveryRate: 1, costPerSuccess: 0, latencyPerSuccess: 0,
    contextContinuityRate: 1,
  };
}