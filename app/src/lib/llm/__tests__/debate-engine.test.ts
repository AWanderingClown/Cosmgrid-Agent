// debate-engine 单测（v0.8 阶段5：对弈编排）
import { describe, it, expect, vi } from "vitest";
import {
  runDebate,
  solverSystemPrompt,
  criticSystemPrompt,
  judgeSystemPrompt,
  type DebateInput,
  type RunRole,
  type DebateRoleConfig,
} from "../debate-engine";

function cfg(role: DebateRoleConfig["role"], modelId: string): DebateRoleConfig {
  return {
    role, modelId, modelName: `${modelId}-name`, providerType: "anthropic",
    providerId: "prov-1", apiCredentialId: "cred-1", apiKey: "k",
  };
}

function input(over: Partial<DebateInput> = {}): DebateInput {
  return {
    topic: "v0.7 是否要做工具沙箱",
    solver: cfg("solver", "m-solver"),
    critic: cfg("critic", "m-critic"),
    judge: cfg("judge", "m-judge"),
    ...over,
  };
}

// 假 runRole：按角色配置返回可识别内容，并记录每次调用
function makeRunRole() {
  const calls: { role: string; systemPrompt: string; userPrompt: string }[] = [];
  const run: RunRole = vi.fn(async ({ systemPrompt, userPrompt, config }) => {
    calls.push({ role: config.role, systemPrompt, userPrompt });
    return { content: `${config.role}-output`, inputTokens: 10, outputTokens: 20 };
  });
  return { run, calls };
}

describe("runDebate — 完整模式", () => {
  it("依次跑 solver → critic → judge，3 轮", async () => {
    const { run, calls } = makeRunRole();
    const r = await runDebate(input(), run);
    expect(r.rounds.map((x) => x.role)).toEqual(["solver", "critic", "judge"]);
    expect(calls.map((c) => c.role)).toEqual(["solver", "critic", "judge"]);
  });

  it("finalSolution = judge 输出", async () => {
    const { run } = makeRunRole();
    const r = await runDebate(input(), run);
    expect(r.finalSolution).toBe("judge-output");
  });

  it("critic 能看到 solver 的方案（上下文传递）", async () => {
    const { run, calls } = makeRunRole();
    await runDebate(input(), run);
    const criticCall = calls.find((c) => c.role === "critic")!;
    expect(criticCall.userPrompt).toContain("solver-output");
  });

  it("judge 能看到 solver 方案 + critic 批评", async () => {
    const { run, calls } = makeRunRole();
    await runDebate(input(), run);
    const judgeCall = calls.find((c) => c.role === "judge")!;
    expect(judgeCall.userPrompt).toContain("solver-output");
    expect(judgeCall.userPrompt).toContain("critic-output");
  });

  it("每轮记录 token 用量", async () => {
    const { run } = makeRunRole();
    const r = await runDebate(input(), run);
    expect(r.rounds.every((x) => x.inputTokens === 10 && x.outputTokens === 20)).toBe(true);
  });
});

describe("runDebate — 快速模式", () => {
  it("跳过 critic，只 solver + judge", async () => {
    const { run, calls } = makeRunRole();
    const r = await runDebate(input({ quickMode: true }), run);
    expect(r.rounds.map((x) => x.role)).toEqual(["solver", "judge"]);
    expect(calls.some((c) => c.role === "critic")).toBe(false);
  });

  it("judge 不含 critic 批评", async () => {
    const { run, calls } = makeRunRole();
    await runDebate(input({ quickMode: true }), run);
    const judgeCall = calls.find((c) => c.role === "judge")!;
    expect(judgeCall.userPrompt).not.toContain("critic-output");
  });
});

describe("runDebate — 错误传播", () => {
  it("某角色抛错则整场抛错", async () => {
    const run: RunRole = vi.fn(async ({ config }) => {
      if (config.role === "critic") throw new Error("critic 模型 401");
      return { content: "x", inputTokens: 1, outputTokens: 1 };
    });
    await expect(runDebate(input(), run)).rejects.toThrow("critic 模型 401");
  });
});

describe("prompt 构造", () => {
  it("三个 system prompt 各有角色特征词", () => {
    expect(solverSystemPrompt()).toContain("Solver");
    expect(criticSystemPrompt()).toContain("Critic");
    expect(judgeSystemPrompt()).toContain("Judge");
  });
});
