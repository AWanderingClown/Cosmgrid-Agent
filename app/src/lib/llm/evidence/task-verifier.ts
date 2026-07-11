// Harness 工程实施计划 阶段3 — Task Verifier（核心对账器）。
//
// 入口函数 `verifyTask`：消费 ToolExecutionRow[] + ToolArtifactRef[] + StructuredAcceptanceCriterion[]，
// 输出 VerificationResult。**只消费结构化事实**，不解析 assistant 文案（claim 提取在
// claim-extractor.ts 里完成，本函数拿到的是已经结构化的 LinkedClaim[]）。
//
// 算法（计划文件 §步骤 E）：
// 1. selectRowsForMessage 归属（多角色不串消息 + legacy 兜底）
// 2. buildEvidenceRefs 装配成 EvidenceRef[]
// 3. extractAllClaims 提声明
// 4. linkClaimsToEvidence 对账
// 5. runAcceptanceCriteria 验标准
// 6. 综合判定 status：passes / fails / inconclusive
//
// 错误降级（关键设计原则 §阶段3 风险 4）：
// 任何抛错都返回 status='inconclusive' + humanSummary 提示"证据加载失败"。
// **绝不**因证据系统故障让用户回答"失败"——这是和 verifyNodeOutcome 的关键区别：
// 粗筛失败 = 真的不行；细对账 inconclusive = "我看不清"。

import { extractAllClaims } from "./claim-extractor";
import { linkClaimsToEvidence } from "./claim-linker";
import { buildEvidenceRefs } from "./evidence-builder";
import { runAcceptanceCriteria } from "./structured-criteria";
import type {
  EvidenceRef,
  LinkedClaim,
  StructuredAcceptanceCriterion,
  VerificationResult,
} from "./types";
import type { ToolExecutionRow } from "@/lib/db";
import type { ToolArtifactRef } from "@/lib/llm/tools/result-contract";

export interface VerifyTaskArgs {
  /** assistant 最终回复全文（用于 claim-extractor 抽取）。 */
  finalContent: string;
  /** 本次对话全部 ToolExecutionRow（含其他 message / 其他 phase）—— verifier 自己用 messageId + sinceIso 归属。 */
  execRows: ToolExecutionRow[];
  /** assistantMessageId：归属锚点（与 fabrication-evidence 一致）。 */
  assistantMessageId: string;
  /** ISO 时间戳，legacy messageId=null 的 row 用 createdAt >= sinceIso 兜底。 */
  sinceIso: string;
  /** 阶段2 工具返回的 artifacts。 */
  artifacts?: ToolArtifactRef[];
  /** verification_closure skill 的结构化验收标准。 */
  acceptanceCriteria: StructuredAcceptanceCriterion[];
  /** 关联 workflow runId + nodeId。 */
  workflowRef: { runId: string; nodeId: string };
}

export function verifyTask(args: VerifyTaskArgs): VerificationResult {
  const decidedAt = new Date().toISOString();

  // 1+2：归属 + 装配
  let evidenceRefs: EvidenceRef[];
  try {
    evidenceRefs = buildEvidenceRefs({
      execRows: args.execRows,
      assistantMessageId: args.assistantMessageId,
      sinceIso: args.sinceIso,
      artifacts: args.artifacts,
      workflowRef: args.workflowRef,
    });
  } catch (err) {
    return inconclusive(
      decidedAt,
      `证据加载失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3：抽声明
  const claims: LinkedClaim[] = extractAllClaims(args.finalContent, {
    acceptanceCriteria: args.acceptanceCriteria,
  });

  // 4：对账（升级 acceptance_met 类 claim 的 verdict）
  const linkedClaims = linkClaimsToEvidence({
    claims,
    evidence: evidenceRefs,
    execRows: args.execRows,
  });

  // 5：跑结构化验收
  const { metCriteria, failedCriteria } = runAcceptanceCriteria(args.acceptanceCriteria, {
    linkedClaims,
    evidenceRefs,
    execRows: args.execRows,
  });

  // 6：综合判定
  const conflicts = linkedClaims.filter(
    (c) => c.verdict === "contradicts" || (c.verdict === "insufficient" && c.kind !== "acceptance_met"),
  );
  const unknownCount = linkedClaims.filter((c) => c.verdict === "unknown").length;

  // 任一 contradicts → fails
  // 任一关键声明（file_modified/command_executed/test_result）insufficient → inconclusive
  // 否则 passes
  const keyClaimInsufficient = linkedClaims.some(
    (c) =>
      c.verdict === "insufficient" &&
      (c.kind === "file_modified" || c.kind === "command_executed" || c.kind === "test_result"),
  );

  let status: VerificationResult["status"];
  if (linkedClaims.some((c) => c.verdict === "contradicts")) {
    status = "fails";
  } else if (keyClaimInsufficient || unknownCount >= 3) {
    status = "inconclusive";
  } else if (failedCriteria.length > 0) {
    // 验收标准未满足 = 任务失败（fails）。注意：这里不再要求 linkedClaims.length > 0，
    // 因为验收标准本身就代表"声称"——若 criteria 全 fail，即使没有任何声称，状态仍是 fails。
    status = "fails";
  } else {
    status = "passes";
  }

  const decisionEvidenceIds = collectDecisionEvidenceIds(linkedClaims);

  return {
    status,
    metCriteria,
    failedCriteria,
    linkedClaims,
    conflicts,
    decidedAt,
    decisionEvidenceIds,
    humanSummary: buildHumanSummary({
      status,
      conflicts,
      metCriteria,
      failedCriteria,
      unknownCount,
      acceptanceCriteria: args.acceptanceCriteria,
    }),
  };
}

// =====================================================================
// helpers
// =====================================================================

function inconclusive(decidedAt: string, reason: string): VerificationResult {
  return {
    status: "inconclusive",
    metCriteria: [],
    failedCriteria: [],
    linkedClaims: [],
    conflicts: [],
    decidedAt,
    decisionEvidenceIds: [],
    humanSummary: `${reason}。请人工复核。`,
  };
}

function collectDecisionEvidenceIds(claims: LinkedClaim[]): string[] {
  const ids = new Set<string>();
  for (const c of claims) for (const id of c.evidenceIds) ids.add(id);
  return [...ids];
}

function buildHumanSummary(args: {
  status: VerificationResult["status"];
  conflicts: LinkedClaim[];
  metCriteria: string[];
  failedCriteria: string[];
  unknownCount: number;
  acceptanceCriteria: StructuredAcceptanceCriterion[];
}): string {
  const lines: string[] = [];
  const criteriaNames = new Map<string, string>(
    args.acceptanceCriteria.map((c) => [c.id, c.description]),
  );

  if (args.status === "passes") {
    if (args.metCriteria.length === 0) {
      lines.push("无结构化验收标准触发，但未发现冲突。");
    } else {
      const names = args.metCriteria.map((id) => criteriaNames.get(id) ?? id).join("、");
      lines.push(`通过：${names}。`);
    }
  } else if (args.status === "fails") {
    const contradicted = args.conflicts.filter((c) => c.verdict === "contradicts");
    const firstConflict = contradicted[0];
    lines.push(
      firstConflict
        ? `失败：${firstConflict.text}（${firstConflict.conflictReason ?? "证据冲突"}）。`
        : "失败：证据与声明冲突。",
    );
  } else {
    // inconclusive
    const insufficient = args.conflicts.filter((c) => c.verdict === "insufficient");
    if (insufficient.length > 0) {
      const evidenceIds = insufficient.flatMap((c) => c.evidenceIds).slice(0, 5);
      lines.push(
        `证据不足：缺 ${insufficient.length} 条声明的支撑证据（evidence_id=${evidenceIds.join(",") || "无"}）。`,
      );
    } else if (args.failedCriteria.length > 0) {
      const names = args.failedCriteria.map((id) => criteriaNames.get(id) ?? id).join("、");
      lines.push(`未满足验收：${names}。`);
    } else {
      lines.push("证据不充分，需要人工复核。");
    }
  }
  if (args.unknownCount >= 3) {
    lines.push(`[证据部分截断，请人工复核]（${args.unknownCount} 条 unknown）`);
  }
  return lines.join("").slice(0, 200);
}