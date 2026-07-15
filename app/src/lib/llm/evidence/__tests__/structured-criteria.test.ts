// structured-criteria 单测（2026-07-14 三态改造，此前 0 覆盖率）。
//
// 重点覆盖：lint/build 的 not_attempted 分支（没跑 ≠ 失败，这是本次修复的核心）、
// test_run 的严格分支（没有真实可核对的测试证据 = failed，不给 not_attempted 退路）、
// typecheck/manual 维持既有语义、runAcceptanceCriteria 的三桶归类。

import { describe, expect, it } from "vitest";
import type { ToolExecutionRow } from "@/lib/db";
import { applyAcceptanceCriterion, runAcceptanceCriteria } from "../structured-criteria";
import type { EvidenceRef, LinkedClaim, StructuredAcceptanceCriterion } from "../types";

function rowOf(over: Partial<ToolExecutionRow>): ToolExecutionRow {
  return {
    id: `row-${Math.random().toString(36).slice(2, 8)}`,
    projectId: null,
    conversationId: "conv-1",
    messageId: "msg-A",
    toolName: "bash",
    input: "{}",
    output: "",
    status: "success",
    userConfirmed: false,
    reversible: false,
    durationMs: 10,
    createdAt: "2026-07-14T00:00:00.000Z",
    resultJson: null,
    errorCode: null,
    ...over,
  };
}

function testClaimOf(over: Partial<LinkedClaim>): LinkedClaim {
  return {
    claimId: `claim-${Math.random().toString(36).slice(2, 8)}`,
    kind: "test_result",
    text: "8 项测试通过",
    evidenceIds: [],
    verdict: "supported",
    ...over,
  };
}

function ctx(over: Partial<{ linkedClaims: LinkedClaim[]; evidenceRefs: EvidenceRef[]; execRows: ToolExecutionRow[] }>) {
  return {
    linkedClaims: [],
    evidenceRefs: [],
    execRows: [],
    ...over,
  };
}

function criterionOf(kind: StructuredAcceptanceCriterion["kind"]): StructuredAcceptanceCriterion {
  return { id: `${kind}_pass`, description: `${kind} 检查`, kind };
}

describe("testRunCheck（严格：没有真实可核对的测试证据 = failed，不给退路）", () => {
  it("完全没有 test_result 声明 → failed", () => {
    const r = applyAcceptanceCriterion(criterionOf("test_run"), ctx({}));
    expect(r.status).toBe("failed");
  });

  it("有声明但 verdict=unknown（如没带具体数字）→ failed（堵住含糊声明的洞）", () => {
    const r = applyAcceptanceCriterion(
      criterionOf("test_run"),
      ctx({ linkedClaims: [testClaimOf({ verdict: "unknown" })] }),
    );
    expect(r.status).toBe("failed");
  });

  it("声明与证据冲突（contradicts）→ failed", () => {
    const r = applyAcceptanceCriterion(
      criterionOf("test_run"),
      ctx({ linkedClaims: [testClaimOf({ verdict: "contradicts" })] }),
    );
    expect(r.status).toBe("failed");
  });

  it("有 supported 声明但没有 bash 成功记录 → failed", () => {
    const r = applyAcceptanceCriterion(
      criterionOf("test_run"),
      ctx({ linkedClaims: [testClaimOf({ verdict: "supported" })], execRows: [] }),
    );
    expect(r.status).toBe("failed");
  });

  it("有 supported 声明 + bash 成功记录 → met", () => {
    const r = applyAcceptanceCriterion(
      criterionOf("test_run"),
      ctx({
        linkedClaims: [testClaimOf({ verdict: "supported" })],
        execRows: [rowOf({ toolName: "bash", status: "success" })],
      }),
    );
    expect(r.status).toBe("met");
  });
});

describe("typecheckCheck（维持现状：没跑等于通过）", () => {
  it("没有 lsp_diagnostics 记录 → met（不区分没跑/跑了没错）", () => {
    const r = applyAcceptanceCriterion(criterionOf("typecheck"), ctx({}));
    expect(r.status).toBe("met");
  });

  it("lsp_diagnostics 报错 → failed", () => {
    const r = applyAcceptanceCriterion(
      criterionOf("typecheck"),
      ctx({ execRows: [rowOf({ toolName: "lsp_diagnostics", status: "error" })] }),
    );
    expect(r.status).toBe("failed");
  });
});

describe("lintCheck（三态改造核心：没跑 ≠ 失败）", () => {
  it("没有匹配的 bash lint 记录 → not_attempted（不是 failed）", () => {
    const r = applyAcceptanceCriterion(criterionOf("lint"), ctx({}));
    expect(r.status).toBe("not_attempted");
  });

  it("跑了 lint 且成功 → met", () => {
    const r = applyAcceptanceCriterion(
      criterionOf("lint"),
      ctx({ execRows: [rowOf({ toolName: "bash", input: '{"command":"npm run lint"}', status: "success" })] }),
    );
    expect(r.status).toBe("met");
  });

  it("跑了 lint 但失败 → failed", () => {
    const r = applyAcceptanceCriterion(
      criterionOf("lint"),
      ctx({ execRows: [rowOf({ toolName: "bash", input: '{"command":"npm run lint"}', status: "error" })] }),
    );
    expect(r.status).toBe("failed");
  });
});

describe("buildCheck（三态改造核心：没跑 ≠ 失败）", () => {
  it("没有匹配的 bash build 记录 → not_attempted", () => {
    const r = applyAcceptanceCriterion(criterionOf("build"), ctx({}));
    expect(r.status).toBe("not_attempted");
  });

  it("跑了 build 且成功 → met", () => {
    const r = applyAcceptanceCriterion(
      criterionOf("build"),
      ctx({ execRows: [rowOf({ toolName: "bash", input: '{"command":"npm run build"}', status: "success" })] }),
    );
    expect(r.status).toBe("met");
  });

  it("跑了 build 但失败 → failed", () => {
    const r = applyAcceptanceCriterion(
      criterionOf("build"),
      ctx({ execRows: [rowOf({ toolName: "bash", input: '{"command":"npm run build"}', status: "error" })] }),
    );
    expect(r.status).toBe("failed");
  });
});

describe("manualCheck（永远 not_attempted，机器不判定）", () => {
  it("恒返回 not_attempted，不是 failed（此前是潜藏 bug：恒 met:false）", () => {
    const r = applyAcceptanceCriterion(criterionOf("manual"), ctx({}));
    expect(r.status).toBe("not_attempted");
  });
});

describe("runAcceptanceCriteria（三桶归类）", () => {
  it("met/failed/not_attempted 各自归类，互不污染", () => {
    const result = runAcceptanceCriteria(
      [
        { id: "lint_pass", description: "lint", kind: "lint" },
        { id: "build_pass", description: "build", kind: "build" },
      ],
      ctx({
        execRows: [rowOf({ toolName: "bash", input: '{"command":"npm run build"}', status: "error" })],
      }),
    );
    // build 跑了且失败 → failed；lint 完全没跑 → not_attempted，两者不互相影响。
    expect(result.failedCriteria).toEqual(["build_pass"]);
    expect(result.notAttemptedCriteria).toEqual(["lint_pass"]);
    expect(result.metCriteria).toEqual([]);
  });

  it("回归防护：只跑测试、没跑 lint/build，且测试声明明确 → 只有 test_run met，lint/build 都是 not_attempted，不会污染成 failed", () => {
    const result = runAcceptanceCriteria(
      [
        { id: "tests_pass", description: "测试", kind: "test_run" },
        { id: "lint_pass", description: "lint", kind: "lint" },
        { id: "build_pass", description: "build", kind: "build" },
      ],
      ctx({
        linkedClaims: [testClaimOf({ verdict: "supported" })],
        execRows: [rowOf({ toolName: "bash", input: '{"command":"npm test"}', status: "success" })],
      }),
    );
    expect(result.metCriteria).toEqual(["tests_pass"]);
    expect(result.failedCriteria).toEqual([]);
    expect(result.notAttemptedCriteria.sort()).toEqual(["build_pass", "lint_pass"]);
  });
});
