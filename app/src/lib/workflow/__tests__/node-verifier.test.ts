// Harness 工程实施计划阶段1 —— 节点完成门控测试（先写失败测试，再实现最小结构）。
import { describe, expect, it } from "vitest";
import { verifyNodeOutcome } from "../node-verifier";

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

  it("verify 阶段 0 工具调用（没有真实测试/构建证据）→ failed", () => {
    const outcome = verifyNodeOutcome({
      phase: "verify",
      harnessDirty: false,
      toolCallCount: 0,
      hasSummary: true,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failureCode).toBe("no_tool_evidence");
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
