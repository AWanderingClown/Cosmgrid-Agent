// Harness 工程实施计划 阶段3 — Evidence Panel 派生函数。
//
// 把 WorkflowSnapshot.outputs.verification + linkedClaims + decisionEvidenceIds 渲染成
// 视图模型 EvidenceView，普通用户 UI 默认折叠显示 humanSummary 一行；
// dev 模式展开 4 区块（声明 / 证据 / 冲突 / 验收决定）。

import type { WorkflowSnapshot } from "@/lib/workflow/types";
import type { LinkedClaim } from "@/lib/llm/evidence/types";

export interface EvidenceView {
  status: "passes" | "fails" | "inconclusive" | "absent";
  /** 人类可读摘要，UI 折叠态直接展示。 */
  humanSummary: string;
  /** 4 区块展示数据，每块可能为空。 */
  claims: LinkedClaim[];
  evidenceIds: string[];
  /** 仅 verdict === "contradicts" 的 claim —— UI 高亮冲突。 */
  conflicts: LinkedClaim[];
  metCriteria: string[];
  failedCriteria: string[];
}

/**
 * 从 WorkflowSnapshot 派生 EvidenceView。
 * - outputs.verification undefined（阶段1/2 的旧 snapshot）→ status="absent"，UI 显示
 *   "暂无证据对账记录"
 * - verification 存在 → 透传到视图模型
 */
export function deriveEvidenceView(snapshot: WorkflowSnapshot | null): EvidenceView {
  if (!snapshot) {
    return emptyView("暂无工作流快照");
  }
  const v = snapshot.context.lastVerificationSummary;
  const outputs = snapshot.nodes.flatMap((n) => (n.outputs ? [n.outputs] : []));
  const verification = outputs.find((o) => o.verification)?.verification;
  if (!verification) {
    return {
      status: "absent",
      humanSummary: v ?? "暂无证据对账记录",
      claims: [],
      evidenceIds: [],
      conflicts: [],
      metCriteria: [],
      failedCriteria: [],
    };
  }
  return {
    status: verification.status,
    humanSummary: v ?? verification.humanSummary,
    claims: verification.linkedClaims,
    evidenceIds: verification.decisionEvidenceIds,
    conflicts: verification.conflicts,
    metCriteria: verification.metCriteria,
    failedCriteria: verification.failedCriteria,
  };
}

function emptyView(humanSummary: string): EvidenceView {
  return {
    status: "absent",
    humanSummary,
    claims: [],
    evidenceIds: [],
    conflicts: [],
    metCriteria: [],
    failedCriteria: [],
  };
}