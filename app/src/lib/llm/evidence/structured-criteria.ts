// Harness 工程实施计划 阶段3 — structured-criteria（verification_closure 结构化 check 实现）。
//
// 阶段1 verification_closure 的 acceptanceCriteria 是 string[]（"列出已通过的检查"），
// 阶段3 升级为结构化数组后，本文件按 kind 调度 5 种 check：
//   - test_run：在 bash 输出里 grep "X passed" / "X 通过"
//   - typecheck：lsp_diagnostics 工具无错误状态
//   - lint：bash 含 lint 关键字且 exit=0
//   - build：bash 含 build 关键字且 exit=0
//   - manual：需人工确认，机器永远判不出 met/failed
//
// 设计：check 函数不写在 StructuredAcceptanceCriterion 类型里（types.ts），避免 registry.ts
// 反向依赖 evidence 模块运行时；本文件按 kind 调度，对外暴露 applyAcceptanceCriterion()。
//
// 2026-07-14 三态改造（接入真实判定前的必要修复）：原实现是布尔 met，lint/build 在"这轮压根
// 没跑这个检查"时也返回 met:false——如果原样接入真实判定，会让大量正常完成的验证轮次（比如
// 只改了文案、只跑了相关测试没跑 lint/build）被误判为失败。改成三态：
//   - "met"：真的跑了，而且通过
//   - "failed"：真的跑了，但失败——这才是真错误
//   - "not_attempted"：这轮没跑这项检查——中性，不算失败也不算通过
// test_run 保持严格（没有真实可核对的测试证据 = failed，不给 not_attempted 这条退路，
// 因为"验证阶段却拿不出任何测试证据"本身就是问题所在）；typecheck 维持现状语义（没跑等于
// 通过，判断不出"跑了没错"和"没跑"，不动它，只是统一返回值形状）；lint/build 改成不跑不算错；
// manual 永远 not_attempted（机器本来就判不出来，不该拖累判定，之前 met:false 是个潜藏 bug）。

import type { EvidenceRef, LinkedClaim, StructuredAcceptanceCriterion } from "./types";
import type { ToolExecutionRow } from "@/lib/db";

interface CheckContext {
  linkedClaims: LinkedClaim[];
  evidenceRefs: EvidenceRef[];
  execRows: ToolExecutionRow[];
}

export type CriterionCheckStatus = "met" | "failed" | "not_attempted";

export interface CriterionCheckResult {
  status: CriterionCheckStatus;
  reason: string;
}

function testRunCheck(ctx: CheckContext): CriterionCheckResult {
  const testClaims = ctx.linkedClaims.filter((c) => c.kind === "test_result");
  if (testClaims.length === 0) {
    return { status: "failed", reason: "无测试相关声明（声称未提及测试结果）" };
  }
  const anyContradicts = testClaims.some((c) => c.verdict === "contradicts");
  if (anyContradicts) {
    return { status: "failed", reason: "测试声明与证据冲突（如声称 X 项通过但 bash 输出不符）" };
  }
  const anySupported = testClaims.some((c) => c.verdict === "supported");
  if (!anySupported) {
    return { status: "failed", reason: "测试声明无 supported 证据（可能 bash 跑了但模型没说通过，或没给具体数字）" };
  }
  const bashOk = ctx.execRows.some((r) => r.toolName === "bash" && r.status === "success");
  if (!bashOk) {
    return { status: "failed", reason: "没有 bash 成功记录，无法证明测试真跑了" };
  }
  return { status: "met", reason: "测试声明有 supported 证据且 bash 成功" };
}

function typecheckCheck(ctx: CheckContext): CriterionCheckResult {
  const typeErrors = ctx.execRows.filter(
    (r) => r.toolName === "lsp_diagnostics" && (r.status === "error" || r.errorCode === "TOOL_DIAGNOSTIC"),
  );
  if (typeErrors.length > 0) {
    return { status: "failed", reason: `lsp_diagnostics 报告 ${typeErrors.length} 个类型错误` };
  }
  return { status: "met", reason: "未发现 LSP 类型错误" };
}

function lintCheck(ctx: CheckContext): CriterionCheckResult {
  const lintRows = ctx.execRows.filter((r) => r.toolName === "bash" && /lint/i.test(r.input));
  if (lintRows.length === 0) {
    return { status: "not_attempted", reason: "本轮没有运行 lint 的 bash 记录（未强制要求）" };
  }
  const lintFailed = lintRows.some((r) => r.status === "error");
  if (lintFailed) {
    return { status: "failed", reason: "lint bash 记录中有失败（exit != 0）" };
  }
  return { status: "met", reason: "所有 lint bash 记录成功" };
}

function buildCheck(ctx: CheckContext): CriterionCheckResult {
  const buildRows = ctx.execRows.filter((r) => r.toolName === "bash" && /build/i.test(r.input));
  if (buildRows.length === 0) {
    return { status: "not_attempted", reason: "本轮没有运行 build 的 bash 记录（未强制要求）" };
  }
  const buildFailed = buildRows.some((r) => r.status === "error");
  if (buildFailed) {
    return { status: "failed", reason: "build bash 记录中有失败（exit != 0）" };
  }
  return { status: "met", reason: "所有 build bash 记录成功" };
}

function manualCheck(): CriterionCheckResult {
  return { status: "not_attempted", reason: "manual 类型的验收标准需要人工确认，机器不判定 met/failed" };
}

const CHECKS = {
  test_run: testRunCheck,
  typecheck: typecheckCheck,
  lint: lintCheck,
  build: buildCheck,
  manual: manualCheck,
} as const;

export function applyAcceptanceCriterion(
  criterion: StructuredAcceptanceCriterion,
  ctx: CheckContext,
): CriterionCheckResult {
  const check = CHECKS[criterion.kind];
  return check(ctx);
}

export function runAcceptanceCriteria(
  criteria: readonly StructuredAcceptanceCriterion[],
  ctx: CheckContext,
): { metCriteria: string[]; failedCriteria: string[]; notAttemptedCriteria: string[] } {
  const metCriteria: string[] = [];
  const failedCriteria: string[] = [];
  const notAttemptedCriteria: string[] = [];
  for (const c of criteria) {
    const result = applyAcceptanceCriterion(c, ctx);
    if (result.status === "met") metCriteria.push(c.id);
    else if (result.status === "failed") failedCriteria.push(c.id);
    else notAttemptedCriteria.push(c.id);
  }
  return { metCriteria, failedCriteria, notAttemptedCriteria };
}
