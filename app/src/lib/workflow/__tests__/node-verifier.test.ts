// Harness 工程实施计划阶段1 —— 节点完成门控测试（先写失败测试，再实现最小结构）。
import { describe, expect, it } from "vitest";
import { MAX_REPAIR_ATTEMPTS, verifyNodeOutcome, applyVerifyRepairLoop } from "../node-verifier";
import type { NodeOutcome } from "../node-outcome";

describe("verifyNodeOutcome", () => {
  it("Harness 判定编造（harnessDirty=true）→ failed，不管是哪个阶段", () => {
    const outcome = verifyNodeOutcome({
      phase: "execute",
      harnessDirty: true,
      toolCallCount: 3,
      hasSummary: true,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failureCode).toBe("harness_dirty");
  });

  it("execute 阶段 0 工具调用却声称完成 → failed（对应 S6 场景）", () => {
    const outcome = verifyNodeOutcome({
      phase: "execute",
      harnessDirty: false,
      toolCallCount: 0,
      hasSummary: true,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failureCode).toBe("no_tool_evidence");
  });

  it("execute 阶段有工具调用 + Harness 干净 → passed", () => {
    const outcome = verifyNodeOutcome({
      phase: "execute",
      harnessDirty: false,
      toolCallCount: 2,
      hasSummary: true,
    });
    expect(outcome.status).toBe("passed");
  });

  it("execute 阶段显式声明「无需改动」时，即使 0 工具调用也算 passed", () => {
    const outcome = verifyNodeOutcome({
      phase: "execute",
      harnessDirty: false,
      toolCallCount: 0,
      hasSummary: true,
      explicitNoopDeclared: true,
    });
    expect(outcome.status).toBe("passed");
  });

  it("verify 阶段 0 工具调用（没有真实测试/构建证据）且未达修复上限 → retryable，打回 execute 修复", () => {
    const outcome = verifyNodeOutcome({
      phase: "verify",
      harnessDirty: false,
      toolCallCount: 0,
      hasSummary: true,
      repairAttempts: 0,
    });
    expect(outcome.status).toBe("retryable");
    expect(outcome.failureCode).toBe("no_tool_evidence");
  });

  it("verify 阶段已修复到上限（repairAttempts=MAX_REPAIR_ATTEMPTS）→ blocked，不再自动重试", () => {
    const outcome = verifyNodeOutcome({
      phase: "verify",
      harnessDirty: false,
      toolCallCount: 0,
      hasSummary: true,
      repairAttempts: MAX_REPAIR_ATTEMPTS,
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.stopReason).toBe("repair_attempts_exhausted");
  });

  it("execute 阶段失败不进入 verify 的修复循环，始终是 failed（repair loop 只对 verify 生效）", () => {
    const outcome = verifyNodeOutcome({
      phase: "execute",
      harnessDirty: false,
      toolCallCount: 0,
      hasSummary: true,
      repairAttempts: 0,
    });
    expect(outcome.status).toBe("failed");
  });

  it("read_project 阶段没有任何工具调用（纯凭空说项目情况）→ failed", () => {
    const outcome = verifyNodeOutcome({
      phase: "read_project",
      harnessDirty: false,
      toolCallCount: 0,
      hasSummary: true,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failureCode).toBe("no_tool_evidence");
  });

  it("plan 阶段不要求工具调用，只要有回答内容且 Harness 干净就 passed", () => {
    const outcome = verifyNodeOutcome({
      phase: "plan",
      harnessDirty: false,
      toolCallCount: 0,
      hasSummary: true,
    });
    expect(outcome.status).toBe("passed");
  });

  it("plan 阶段回答为空 → failed（没有产出方案）", () => {
    const outcome = verifyNodeOutcome({
      phase: "plan",
      harnessDirty: false,
      toolCallCount: 0,
      hasSummary: false,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failureCode).toBe("empty_output");
  });

  it("review/debate 阶段不要求工具调用，只要有内容且 Harness 干净就 passed", () => {
    expect(
      verifyNodeOutcome({ phase: "review", harnessDirty: false, toolCallCount: 0, hasSummary: true }).status,
    ).toBe("passed");
    expect(
      verifyNodeOutcome({ phase: "debate", harnessDirty: false, toolCallCount: 0, hasSummary: true }).status,
    ).toBe("passed");
  });

  it("用户拒绝写权限 → needs_user，不判定为失败或成功", () => {
    const outcome = verifyNodeOutcome({
      phase: "execute",
      harnessDirty: false,
      toolCallCount: 0,
      hasSummary: true,
      userDeniedPermission: true,
    });
    expect(outcome.status).toBe("needs_user");
  });

  it("用户主动取消（abort）→ needs_user，不进入失败/修复流程", () => {
    const outcome = verifyNodeOutcome({
      phase: "execute",
      harnessDirty: false,
      toolCallCount: 0,
      hasSummary: true,
      controllerAborted: true,
    });
    expect(outcome.status).toBe("needs_user");
  });

  it("outcome 附带传入的 evidence 引用（toolExecutionIds）", () => {
    const outcome = verifyNodeOutcome({
      phase: "execute",
      harnessDirty: false,
      toolCallCount: 2,
      hasSummary: true,
      toolExecutionIds: ["te-1", "te-2"],
    });
    expect(outcome.toolExecutionIds).toEqual(["te-1", "te-2"]);
  });
});

// 2026-07-14：applyVerifyRepairLoop 导出后独立单测（此前只在 verifyNodeOutcome 内部被间接
// 测到）——stream-finalization.ts 现在也直接调用它，把细对账 fails 结果降级成 retryable/
// blocked，复用同一套 MAX_REPAIR_ATTEMPTS 上限，不是另开一条不受控的重试路径。
describe("applyVerifyRepairLoop（导出复用，细对账/粗筛共用同一套受控重试上限）", () => {
  function failedOutcome(over: Partial<NodeOutcome> = {}): NodeOutcome {
    return {
      status: "failed",
      summary: "验收未通过",
      evidenceIds: [],
      artifactIds: [],
      toolExecutionIds: [],
      failureCode: "acceptance_criteria_failed",
      ...over,
    };
  }

  it("非 verify 阶段：failed 原样返回，不进入修复循环", () => {
    const result = applyVerifyRepairLoop(failedOutcome(), { phase: "execute", repairAttempts: 0 });
    expect(result.status).toBe("failed");
  });

  it("verify 阶段 + status 不是 failed：原样返回（不误伤 passed/needs_user 等状态）", () => {
    const result = applyVerifyRepairLoop(
      { status: "passed", summary: "ok", evidenceIds: [], artifactIds: [], toolExecutionIds: [] },
      { phase: "verify", repairAttempts: 0 },
    );
    expect(result.status).toBe("passed");
  });

  it("verify 阶段 + failed + repairAttempts 未到上限 → retryable，保留原 failureCode", () => {
    const result = applyVerifyRepairLoop(failedOutcome(), { phase: "verify", repairAttempts: 0 });
    expect(result.status).toBe("retryable");
    expect(result.failureCode).toBe("acceptance_criteria_failed");
  });

  it("verify 阶段 + failed + repairAttempts 已达上限 → blocked，stopReason 说明原因", () => {
    const result = applyVerifyRepairLoop(failedOutcome(), {
      phase: "verify",
      repairAttempts: MAX_REPAIR_ATTEMPTS,
    });
    expect(result.status).toBe("blocked");
    expect(result.stopReason).toBe("repair_attempts_exhausted");
  });

  it("不传 repairAttempts（undefined）时按 0 处理，不会误判成已达上限", () => {
    const result = applyVerifyRepairLoop(failedOutcome(), { phase: "verify" });
    expect(result.status).toBe("retryable");
  });
});
