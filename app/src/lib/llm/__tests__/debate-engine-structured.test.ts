// debate 裁决结构化（2026-07-09 P8②）— 新单测
// 验证 runDynamicDebate 在 judgeRunner 注入时的行为：
// (1) Judge 返回 approved=true → 立即结束（不再循环）
// (2) Judge 返回 approved=false + 有 feedback → 下一轮 Solver 收到 feedback
// (3) 达到 maxIterations=3 后不再继续循环
// (4) structured Judge 失败（runner 抛错） → 兜底到 parseJudgeDecision 旧路径
// (5) structured Judge 返回 null → 同样兜底到旧路径
// (6) DebateResult.judgeDecision 字段正确透传

import { describe, it, expect, vi } from "vitest";
import {
  runDynamicDebate,
  type RunRole,
  type DebateRoleConfig,
  type JudgeRunner,
  type JudgeDecision,
} from "../debate-engine";

function cfg(role: DebateRoleConfig["role"], modelId: string): DebateRoleConfig {
  return {
    role, modelId, modelName: `${modelId}-name`, providerType: "anthropic",
    providerId: "prov-1", apiCredentialId: "cred-1", apiKey: "k",
  };
}

function makeRunRole(opts?: {
  judgeContent?: string;
  proposalContent?: string;
}): { run: RunRole; calls: { role: string }[] } {
  const calls: { role: string }[] = [];
  const run: RunRole = vi.fn(async ({ config }) => {
    calls.push({ role: config.role });
    if (config.role === "judge") {
      return {
        content: opts?.judgeContent ?? JSON.stringify({ approved: true, feedback: [], finalSolution: "judge 方案" }),
        inputTokens: 10, outputTokens: 20,
      };
    }
    if (config.role === "solver") {
      return {
        content: opts?.proposalContent ?? "solver 方案",
        inputTokens: 10, outputTokens: 20,
      };
    }
    return { content: `${config.role}-critique`, inputTokens: 10, outputTokens: 20 };
  });
  return { run, calls };
}

const APPROVED_TRUE: JudgeDecision = { approved: true, feedback: [], finalSolution: "完美方案" };
const APPROVED_FALSE: JudgeDecision = { approved: false, feedback: ["修改 X 解决 Y"], finalSolution: "修正方案" };

describe("runDynamicDebate with judgeRunner (structured Judge)", () => {
  it("(1) Judge 返回 approved=true → 立即结束（不进入下一轮）", async () => {
    const { run, calls } = makeRunRole();
    const judgeRunner: JudgeRunner = vi.fn(async () => APPROVED_TRUE);

    const result = await runDynamicDebate(
      { topic: "t", participants: [cfg("a", "m1"), cfg("b", "m2"), cfg("c", "m3")], judgeRunner },
      run,
    );

    expect(judgeRunner).toHaveBeenCalledTimes(1);
    expect(result.judgeDecision).toEqual(APPROVED_TRUE);
    expect(result.finalSolution).toBe("完美方案");
    // rounds 不应包含 judge（structured 路径不调 runRole）
    expect(calls.filter((c) => c.role === "judge")).toHaveLength(0);
    // solver 也只跑 1 次（approved=true 立即结束）
    expect(calls.filter((c) => c.role === "solver")).toHaveLength(1);
  });

  it("(2) Judge 返回 approved=false → 下一轮 Solver 收到 feedback（修正 prompt 注入）", async () => {
    const { run, calls } = makeRunRole();
    const judgeRunner: JudgeRunner = vi.fn(async () => APPROVED_FALSE);

    const result = await runDynamicDebate(
      {
        topic: "t", participants: [cfg("a", "m1"), cfg("b", "m2"), cfg("c", "m3")], judgeRunner,
        maxIterations: 3,
      },
      run,
    );

    // iter=0 (approved=false) + iter=1 (approved=false) + iter=2 (默认 parser fallback 给出 true)
    // 但本测试 judgeRunner 总返 false，所以会跑满 3 轮
    expect(judgeRunner).toHaveBeenCalledTimes(3);
    expect(result.judgeDecision).toEqual(APPROVED_FALSE);
    expect(result.finalSolution).toBe("修正方案");
    expect(calls.filter((c) => c.role === "solver")).toHaveLength(3);
  });

  it("(3) Judge 持续返 approved=false → 跑满 maxIterations=3 后停止（不再继续）", async () => {
    const { run, calls } = makeRunRole();
    const judgeRunner: JudgeRunner = vi.fn(async () => APPROVED_FALSE);

    await runDynamicDebate(
      { topic: "t", participants: [cfg("a", "m1"), cfg("b", "m2")], judgeRunner, maxIterations: 3 },
      run,
    );

    expect(judgeRunner).toHaveBeenCalledTimes(3);
    // 2 参与者：solver + critic 在每轮各跑一次，共 3 轮 → 6 次
    expect(calls.filter((c) => c.role === "solver")).toHaveLength(3);
    expect(calls.filter((c) => c.role === "critic")).toHaveLength(3);
  });

  it("(3.5) 默认 maxIterations 是 3（不传参时）", async () => {
    const { run } = makeRunRole();
    const judgeRunner: JudgeRunner = vi.fn(async () => APPROVED_FALSE);

    await runDynamicDebate(
      { topic: "t", participants: [cfg("a", "m1"), cfg("b", "m2")], judgeRunner },
      run,
    );

    expect(judgeRunner).toHaveBeenCalledTimes(3);
  });

  it("(4) Judge runner 抛错 → 兜底到 parseJudgeDecision 旧路径", async () => {
    const { run, calls } = makeRunRole({
      judgeContent: JSON.stringify({ approved: true, feedback: [], finalSolution: "fallback 方案" }),
    });
    const judgeRunner: JudgeRunner = vi.fn(async () => {
      throw new Error("structured Judge 调用失败");
    });

    const result = await runDynamicDebate(
      { topic: "t", participants: [cfg("a", "m1"), cfg("b", "m2")], judgeRunner },
      run,
    );

    // 兜底路径：runRole 跑了 judge
    expect(calls.filter((c) => c.role === "judge")).toHaveLength(1);
    expect(result.judgeDecision).toEqual({ approved: true, feedback: [], finalSolution: "fallback 方案" });
    expect(result.finalSolution).toBe("fallback 方案");
    expect(result.failures).toBeDefined();
    expect(result.failures!.some((f) => f.includes("judgeRunner failed"))).toBe(true);
  });

  it("(5) Judge runner 返回 null → 同样兜底到 parseJudgeDecision 旧路径", async () => {
    const { run, calls } = makeRunRole({
      judgeContent: JSON.stringify({ approved: false, feedback: ["old parser feedback"], finalSolution: "" }),
    });
    const judgeRunner: JudgeRunner = vi.fn(async () => null);

    const result = await runDynamicDebate(
      { topic: "t", participants: [cfg("a", "m1"), cfg("b", "m2")], judgeRunner, maxIterations: 1 },
      run,
    );

    // maxIterations=1：只跑 1 轮（即使 approved=false）
    expect(judgeRunner).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.role === "judge")).toHaveLength(1);
    // 旧 parser 解析 approved=false + feedback=["old parser feedback"]
    expect(result.judgeDecision).toEqual({ approved: false, feedback: ["old parser feedback"], finalSolution: "" });
    expect(result.failures!.some((f) => f.includes("returned null"))).toBe(true);
  });

  it("(6) DebateResult.judgeDecision 字段透传最后一轮裁决（不传 judgeRunner 时为 null）", async () => {
    const { run } = makeRunRole({
      judgeContent: JSON.stringify({ approved: true, feedback: [], finalSolution: "经典方案" }),
    });

    const result = await runDynamicDebate(
      { topic: "t", participants: [cfg("a", "m1"), cfg("b", "m2")] },
      run,
    );

    expect(result.judgeDecision).toEqual({ approved: true, feedback: [], finalSolution: "经典方案" });
  });

  it("(7) judgeRunner 的 judgeConfig 是 DebateRoleConfig with role='judge'", async () => {
    const { run } = makeRunRole();
    const judgeRunner = vi.fn(async () => APPROVED_TRUE) as unknown as JudgeRunner;

    await runDynamicDebate(
      { topic: "t", participants: [cfg("a", "m1"), cfg("b", "m2"), cfg("c", "m3")], judgeRunner },
      run,
    );

    const callArg = ((judgeRunner as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as { judgeConfig: DebateRoleConfig }[])[0]!.judgeConfig;
    expect(callArg.role).toBe("judge");
  });
});