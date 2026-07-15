import { describe, expect, it } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "@/lib/workflow/code-task-template";
import type { WorkflowSnapshot } from "@/lib/workflow/types";
import type {
  LinkedClaim,
  VerificationResult,
} from "@/lib/llm/evidence/types";
import { deriveEvidenceView } from "../derive-evidence";

// 构造一个带 verification 的 snapshot —— 模拟 verify 阶段产出了结构化对账结果。
function snapshotWithVerification(
  verification: VerificationResult,
  lastVerificationSummary?: string,
): WorkflowSnapshot {
  const base = createCodeTaskWorkflowSnapshot({
    runId: "run-1",
    conversationId: "conv-1",
    objective: "测试证据面板",
    workspacePath: "/repo",
    executionMode: "execute_directly",
  });
  // 把 verification 挂到 verify 节点的 outputs 上，和 derive-evidence 的查找路径一致。
  return {
    ...base,
    currentNodeId: "verify",
    nodes: base.nodes.map((n) =>
      n.id === "verify"
        ? { ...n, status: "done" as const, outputs: { verification } }
        : n,
    ),
    context: {
      ...base.context,
      lastVerificationSummary,
    },
  };
}

function makeClaim(overrides: Partial<LinkedClaim> = {}): LinkedClaim {
  return {
    claimId: "claim-1",
    kind: "file_modified",
    text: "修改了 src/index.ts",
    evidenceIds: ["ev-1"],
    verdict: "supported",
    ...overrides,
  };
}

describe("deriveEvidenceView", () => {
  it("null snapshot → absent，显示干净空态", () => {
    const view = deriveEvidenceView(null);
    expect(view.status).toBe("absent");
    expect(view.humanSummary).toBe("暂无工作流快照");
    expect(view.claims).toEqual([]);
    expect(view.evidenceIds).toEqual([]);
    expect(view.conflicts).toEqual([]);
    expect(view.metCriteria).toEqual([]);
    expect(view.failedCriteria).toEqual([]);
  });

  it("有 snapshot 但无 verification → absent，显示干净空态", () => {
    const snapshot = createCodeTaskWorkflowSnapshot({
      runId: "run-1",
      conversationId: "conv-1",
      objective: "还没到 verify 阶段",
      workspacePath: "/repo",
    });
    const view = deriveEvidenceView(snapshot);
    expect(view.status).toBe("absent");
    // 没有 lastVerificationSummary 时用默认文案
    expect(view.humanSummary).toBe("暂无证据对账记录");
    expect(view.claims).toEqual([]);
  });

  it("有 snapshot 但无 verification，有 lastVerificationSummary → absent 但显示摘要", () => {
    const snapshot = createCodeTaskWorkflowSnapshot({
      runId: "run-1",
      conversationId: "conv-1",
      objective: "旧 snapshot",
      workspacePath: "/repo",
    });
    const withSummary = {
      ...snapshot,
      context: { ...snapshot.context, lastVerificationSummary: "上次验证已通过" },
    };
    const view = deriveEvidenceView(withSummary);
    expect(view.status).toBe("absent");
    expect(view.humanSummary).toBe("上次验证已通过");
  });

  it("verification status=passes → 透传通过状态 + 声明 + 证据", () => {
    const verification: VerificationResult = {
      status: "passes",
      metCriteria: ["tests_pass", "typecheck_pass"],
      failedCriteria: [],
      linkedClaims: [
        makeClaim({ claimId: "c1", verdict: "supported" }),
        makeClaim({
          claimId: "c2",
          kind: "command_executed",
          text: "跑了 pnpm test",
          verdict: "supported",
        }),
      ],
      conflicts: [],
      decidedAt: "2026-07-15T00:00:00.000Z",
      decisionEvidenceIds: ["ev-1", "ev-2"],
      humanSummary: "所有声明均有证据支持，验收标准全部满足",
    };
    const view = deriveEvidenceView(snapshotWithVerification(verification));
    expect(view.status).toBe("passes");
    expect(view.humanSummary).toBe("所有声明均有证据支持，验收标准全部满足");
    expect(view.claims).toHaveLength(2);
    expect(view.evidenceIds).toEqual(["ev-1", "ev-2"]);
    expect(view.conflicts).toEqual([]);
    expect(view.metCriteria).toEqual(["tests_pass", "typecheck_pass"]);
    expect(view.failedCriteria).toEqual([]);
  });

  it("verification status=fails → 透传失败状态 + 冲突声明高亮", () => {
    const conflictClaim: LinkedClaim = {
      claimId: "c-bad",
      kind: "test_result",
      text: "测试全通过",
      evidenceIds: ["ev-3"],
      verdict: "contradicts",
      conflictReason: "claimed=10 tests passed, evidence=8 passed 2 failed",
    };
    const verification: VerificationResult = {
      status: "fails",
      metCriteria: [],
      failedCriteria: ["tests_pass"],
      linkedClaims: [
        makeClaim({ claimId: "c1", verdict: "supported" }),
        conflictClaim,
      ],
      conflicts: [conflictClaim],
      decidedAt: "2026-07-15T00:00:00.000Z",
      decisionEvidenceIds: ["ev-3"],
      humanSummary: "1 条声明与证据冲突，验收标准未满足",
    };
    const view = deriveEvidenceView(snapshotWithVerification(verification));
    expect(view.status).toBe("fails");
    expect(view.conflicts).toHaveLength(1);
    expect(view.conflicts[0].conflictReason).toContain("claimed=10");
    expect(view.failedCriteria).toEqual(["tests_pass"]);
  });

  it("verification status=inconclusive → 透传证据不足状态", () => {
    const verification: VerificationResult = {
      status: "inconclusive",
      metCriteria: [],
      failedCriteria: [],
      linkedClaims: [
        makeClaim({ claimId: "c1", verdict: "insufficient" }),
        makeClaim({
          claimId: "c2",
          verdict: "unknown",
          text: "证据被截断",
        }),
      ],
      conflicts: [],
      decidedAt: "2026-07-15T00:00:00.000Z",
      decisionEvidenceIds: [],
      humanSummary: "部分声明证据不足，无法判定",
    };
    const view = deriveEvidenceView(snapshotWithVerification(verification));
    expect(view.status).toBe("inconclusive");
    expect(view.humanSummary).toBe("部分声明证据不足，无法判定");
    expect(view.conflicts).toEqual([]);
  });

  it("lastVerificationSummary 优先于 verification.humanSummary", () => {
    const verification: VerificationResult = {
      status: "passes",
      metCriteria: [],
      failedCriteria: [],
      linkedClaims: [],
      conflicts: [],
      decidedAt: "2026-07-15T00:00:00.000Z",
      decisionEvidenceIds: [],
      humanSummary: "verification 内置摘要",
    };
    const view = deriveEvidenceView(
      snapshotWithVerification(verification, "上下文摘要优先"),
    );
    expect(view.humanSummary).toBe("上下文摘要优先");
  });
});
