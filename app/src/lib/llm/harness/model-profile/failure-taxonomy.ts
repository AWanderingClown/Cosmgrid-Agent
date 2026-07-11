// Harness 工程实施计划 阶段6 — Failure Taxonomy 5 个映射函数（纯函数）。
//
// 把现有各模块的"失败信号"统一映射到 10 类 FailureKind：
// 1. failureKindFromHarnessVerdict    — evaluateHarness verdict + fabrication A/B 档
// 2. failureKindFromToolResult         — TOOL_INVALID_PARAMS / TOOL_DOOM_LOOP / TOOL_DIAGNOSTIC
// 3. failureKindFromLlmErrorCategory   — error-classifier.ts 的 LlmErrorCategory
// 4. failureKindFromEvalResult         — eval_results.failureCode 拆分 primary / secondary
// 5. failureKindFromTaskOutcome        — task_outcomes.outcome 映射
//
// 关键不变量：
// - 纯函数：相同输入永远产生相同 FailureKind
// - 多对一：多个信号可能映射到同一 FailureKind（不冒充精确）
// - 单 input 永不返 null（default 走 "unknown_error" / "stale_context" 兜底）

import type { TaskOutcomeValue } from "@/lib/db";
import type { FailureKind } from "./types";

const TOOL_INVALID_PARAMS = "TOOL_INVALID_PARAMS";
const TOOL_DOOM_LOOP = "TOOL_DOOM_LOOP";
const TOOL_DIAGNOSTIC = "TOOL_DIAGNOSTIC";

/** 1. Harness verdict → FailureKind
 *  - A 档 fabrication + 0 工具调用 → "no_tool_completion"
 *  - B 档 fabrication + 有工具调用 + 仍有 unverified claim → "partial_fabrication"
 *  - other → "unknown_error"（不在 taxonomy 范围内的统一兜底） */
export function failureKindFromHarnessVerdict(args: {
  fabricationBand: "A" | "B" | false;
  toolCallCount: number;
  unverifiedPaths: number;
  unverifiedUrls: number;
  unverifiedCommands: number;
  intentNoToolCall: boolean;
}): FailureKind {
  if (args.intentNoToolCall && args.toolCallCount === 0) return "no_tool_completion";
  if (args.fabricationBand === "A") return "no_tool_completion";
  if (args.fabricationBand === "B") return "partial_fabrication";
  if (args.unverifiedPaths + args.unverifiedUrls + args.unverifiedCommands > 0) return "partial_fabrication";
  return "stale_context"; // 兜底：verdict 失败但无明确信号
}

/** 2. ToolResult → FailureKind
 *  - 复用 TOOL_* 稳定错误码（result-contract.ts 第 3 阶段已建） */
export function failureKindFromToolResult(args: {
  toolName: string;
  status: "success" | "error" | "denied" | "timeout";
  errorCode: string | null;
}): FailureKind {
  if (args.status === "success") return "stale_context"; // 成功不算失败 —— 兜底
  if (args.errorCode === TOOL_INVALID_PARAMS) return "invalid_tool_args";
  if (args.errorCode === TOOL_DOOM_LOOP) return "repeated_tool_call";
  if (args.errorCode === TOOL_DIAGNOSTIC) return "invalid_structured_output";
  // bash / web_fetch / web_search 等工具错误归到 stale_context
  return "stale_context";
}

/** 3. LlmErrorCategory → FailureKind
 *  - 直接映射（error-classifier.ts 已分类） */
export function failureKindFromLlmErrorCategory(category: string): FailureKind {
  if (category === "rate_limit") return "rate_limit";
  if (category === "context_overflow") return "context_overflow";
  if (category === "session_limit" || category === "all_models_cooling") return "session_limit";
  if (category === "timeout" || category === "network") return "stale_context";
  return "stale_context";
}

/** 4. EvalResult → FailureKind
 *  - failureCode 拆分 primary / secondary（failure_kinds_json 数组）
 *  - 返回主 FailureKind（最具体那个） */
export function failureKindFromEvalResult(args: {
  passed: boolean | null;
  failureCode: string | null;
}): FailureKind {
  if (args.passed === true) return "stale_context"; // 成功不算失败
  if (!args.failureCode) return "stale_context";
  if (args.failureCode === "TEST_FAILED") return "premature_completion";
  if (args.failureCode === "BUDGET_EXCEEDED") return "stale_context";
  if (args.failureCode === "TIMEOUT") return "stale_context";
  if (args.failureCode === "TOOL_INVALID_PARAMS") return "invalid_tool_args";
  if (args.failureCode === "TOOL_DOOM_LOOP") return "repeated_tool_call";
  if (args.failureCode === "EVIDENCE_INSUFFICIENT") return "partial_fabrication";
  if (args.failureCode === "TOOL_DENIED") return "stale_context";
  return "stale_context";
}

/** 5. TaskOutcome → FailureKind
 *  - plan 文件 §风险 8 标注 retryable / needs_user 显式映射
 *  - 其他失败通过 plan §表格分类 */
export function failureKindFromTaskOutcome(args: {
  outcome: TaskOutcomeValue;
  interventionKind: string | null;
}): FailureKind {
  switch (args.outcome) {
    case "passed":
      return "stale_context"; // 成功不算失败
    case "failed":
      return "premature_completion";
    case "retryable":
      return "repeated_tool_call";
    case "blocked":
      return "premature_completion";
    case "needs_user":
      return "stale_context";
    case "cancelled":
      return "stale_context";
  }
}
