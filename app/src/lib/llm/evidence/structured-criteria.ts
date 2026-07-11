// Harness 工程实施计划 阶段3 — structured-criteria（verification_closure skill 的结构化 check 实现）。
//
// 阶段1 verification_closure 的 acceptanceCriteria 是 string[]（"列出已通过的检查"），
// 阶段3 升级为结构化数组后，本文件按 kind 调度 4 种 check：
//   - test_run：在 bash 输出里 grep "X passed" / "X 通过"
//   - typecheck：lsp_diagnostics 工具无错误状态
//   - lint：bash 含 lint 关键字且 exit=0
//   - build：bash 含 build 关键字且 exit=0
//   - manual：永远 inconclusive（"需人工确认"）—— 阶段3 不假装能自动验
//
// 设计：check 函数不写在 StructuredAcceptanceCriterion 类型里（types.ts），避免 registry.ts
// 反向依赖 evidence 模块运行时；本文件按 kind 调度，对外暴露 applyAcceptanceCriterion()。

import type { EvidenceRef, LinkedClaim, StructuredAcceptanceCriterion } from "./types";
import type { ToolExecutionRow } from "@/lib/db";

interface CheckContext {
  linkedClaims: LinkedClaim[];
  evidenceRefs: EvidenceRef[];
  execRows: ToolExecutionRow[];
}

function testRunCheck(ctx: CheckContext): { met: boolean; reason: string } {
  const testClaims = ctx.linkedClaims.filter((c) => c.kind === "test_result");
  if (testClaims.length === 0) {
    return { met: false, reason: "无测试相关声明（声称未提及测试结果）" };
  }
  const anyContradicts = testClaims.some((c) => c.verdict === "contradicts");
  if (anyContradicts) {
    return { met: false, reason: "测试声明与证据冲突（如声称 X 项通过但 bash 输出不符）" };
  }
  const anySupported = testClaims.some((c) => c.verdict === "supported");
  if (!anySupported) {
    return { met: false, reason: "测试声明无 supported 证据（可能 bash 跑了但模型没说通过）" };
  }
  const bashOk = ctx.execRows.some((r) => r.toolName === "bash" && r.status === "success");
  if (!bashOk) {
    return { met: false, reason: "没有 bash 成功记录，无法证明测试真跑了" };
  }
  return { met: true, reason: "测试声明有 supported 证据且 bash 成功" };
}

function typecheckCheck(ctx: CheckContext): { met: boolean; reason: string } {
  const typeErrors = ctx.execRows.filter(
    (r) => r.toolName === "lsp_diagnostics" && (r.status === "error" || r.errorCode === "TOOL_DIAGNOSTIC"),
  );
  if (typeErrors.length > 0) {
    return { met: false, reason: `lsp_diagnostics 报告 ${typeErrors.length} 个类型错误` };
  }
  return { met: true, reason: "未发现 LSP 类型错误" };
}

function lintCheck(ctx: CheckContext): { met: boolean; reason: string } {
  const lintRows = ctx.execRows.filter((r) => r.toolName === "bash" && /lint/i.test(r.input));
  if (lintRows.length === 0) {
    return { met: false, reason: "没有运行 lint 工具的 bash 记录" };
  }
  const lintFailed = lintRows.some((r) => r.status === "error");
  if (lintFailed) {
    return { met: false, reason: "lint bash 记录中有失败（exit != 0）" };
  }
  return { met: true, reason: "所有 lint bash 记录成功" };
}

function buildCheck(ctx: CheckContext): { met: boolean; reason: string } {
  const buildRows = ctx.execRows.filter((r) => r.toolName === "bash" && /build/i.test(r.input));
  if (buildRows.length === 0) {
    return { met: false, reason: "没有运行 build 工具的 bash 记录" };
  }
  const buildFailed = buildRows.some((r) => r.status === "error");
  if (buildFailed) {
    return { met: false, reason: "build bash 记录中有失败（exit != 0）" };
  }
  return { met: true, reason: "所有 build bash 记录成功" };
}

function manualCheck(): { met: boolean; reason: string } {
  return { met: false, reason: "manual 类型的验收标准需要人工确认（阶段3 不假装自动验）" };
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
): { met: boolean; reason: string } {
  const check = CHECKS[criterion.kind];
  return check(ctx);
}

export function runAcceptanceCriteria(
  criteria: readonly StructuredAcceptanceCriterion[],
  ctx: CheckContext,
): { metCriteria: string[]; failedCriteria: string[] } {
  const metCriteria: string[] = [];
  const failedCriteria: string[] = [];
  for (const c of criteria) {
    const result = applyAcceptanceCriterion(c, ctx);
    if (result.met) metCriteria.push(c.id);
    else failedCriteria.push(c.id);
  }
  return { metCriteria, failedCriteria };
}