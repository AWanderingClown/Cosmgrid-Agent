// debate-engine 单测（v0.8 阶段5：对弈编排）
import { describe, it, expect, vi } from "vitest";
import {
  runDebate,
  runDynamicDebate,
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

describe("runDynamicDebate — 动态参与模型", () => {
  it("把 abort signal 透传给每个参与角色", async () => {
    const controller = new AbortController();
    const seenSignals: (AbortSignal | undefined)[] = [];
    const run: RunRole = vi.fn(async ({ signal, config }) => {
      seenSignals.push(signal);
      return { content: `${config.role}-output`, inputTokens: 1, outputTokens: 1 };
    });

    await runDynamicDebate({
      topic: "比较两个实现方案",
      participants: [cfg("solver", "m-a"), cfg("critic", "m-b")],
      signal: controller.signal,
    }, run);

    expect(seenSignals).toEqual([controller.signal, controller.signal, controller.signal]);
  });

  it("用户停止后不再继续启动下一轮模型调用", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const run: RunRole = vi.fn(async ({ config }) => {
      calls.push(config.role);
      controller.abort();
      return { content: `${config.role}-output`, inputTokens: 1, outputTokens: 1 };
    });

    await expect(runDynamicDebate({
      topic: "比较两个实现方案",
      participants: [cfg("solver", "m-a"), cfg("critic", "m-b")],
      signal: controller.signal,
    }, run)).rejects.toThrow("AbortError");

    expect(calls).toEqual(["solver"]);
  });

  it("只有 1 个模型时做单模型自审，不伪装成 PK", async () => {
    const { run, calls } = makeRunRole();
    const r = await runDynamicDebate({
      topic: "方案是否可行",
      participants: [cfg("solver", "m-only")],
    }, run);

    expect(r.rounds.map((x) => x.role)).toEqual(["solo_review"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.systemPrompt).toContain("不能伪装成多模型 PK");
  });

  it("2 个模型时 A 出方案、B 反驳、A 汇总", async () => {
    const { run, calls } = makeRunRole();
    const r = await runDynamicDebate({
      topic: "比较两个实现方案",
      participants: [cfg("solver", "m-a"), cfg("critic", "m-b")],
    }, run);

    expect(r.rounds.map((x) => x.role)).toEqual(["solver", "critic", "judge"]);
    expect(r.rounds.map((x) => x.modelId)).toEqual(["m-a", "m-b", "m-a"]);
    expect(calls.map((c) => c.role)).toEqual(["solver", "critic", "judge"]);
  });

  it("3 个及以上模型时最后一个做裁决，中间模型反驳", async () => {
    const { run } = makeRunRole();
    const r = await runDynamicDebate({
      topic: "多模型 PK",
      participants: [
        cfg("solver", "m-a"),
        cfg("critic", "m-b"),
        cfg("critic", "m-c"),
        cfg("judge", "m-d"),
      ],
    }, run);

    expect(r.rounds.map((x) => x.role)).toEqual(["solver", "critic", "critic_2", "judge"]);
    expect(r.rounds.map((x) => x.modelId)).toEqual(["m-a", "m-b", "m-c", "m-d"]);
  });
});

describe("prompt 构造", () => {
  it("三个 system prompt 各有角色特征词", () => {
    expect(solverSystemPrompt()).toContain("Solver");
    expect(criticSystemPrompt()).toContain("Red Team");
    expect(judgeSystemPrompt()).toContain("Judge");
  });

  it("critic prompt 是红队反方，不是温和补充建议", () => {
    const prompt = criticSystemPrompt();
    expect(prompt).toContain("完全对立面");
    expect(prompt).toContain("攻击方案");
    expect(prompt).toContain("禁止客套");
  });
});

describe("runDynamicDebate 降级（单参与者失败不全挂）", () => {
  it("proposer 失败 → 换下一个参与者顶上出方案", async () => {
    const calls: string[] = [];
    const run: RunRole = vi.fn(async ({ config }) => {
      calls.push(`${config.modelId}:${config.role}`);
      if (config.modelId === "m-a" && config.role === "solver") {
        throw new Error("模型「m-a-name」（solver）调用失败：Load failed");
      }
      return { content: `${config.modelId}-${config.role}`, inputTokens: 1, outputTokens: 2 };
    });
    const r = await runDynamicDebate(
      { topic: "T", participants: [cfg("p1", "m-a"), cfg("p2", "m-b"), cfg("p3", "m-c")] },
      run,
    );
    // m-a 出方案失败 → m-b 顶上当 solver，最终能产出
    expect(r.rounds.find((x) => x.role === "solver")?.modelId).toBe("m-b");
    expect(r.finalSolution).toContain("失败");
  });

  it("critic 失败 → 跳过它，judge 仍产出最终方案", async () => {
    const run: RunRole = vi.fn(async ({ config }) => {
      if (config.role === "critic") throw new Error("模型「x」（critic）调用失败：boom");
      return { content: `${config.modelId}-${config.role}`, inputTokens: 1, outputTokens: 2 };
    });
    const r = await runDynamicDebate(
      { topic: "T", participants: [cfg("p1", "m-a"), cfg("p2", "m-b"), cfg("p3", "m-c")] },
      run,
    );
    expect(r.rounds.some((x) => x.role === "judge")).toBe(true);
    expect(r.finalSolution).toContain("失败");
  });

  it("全部参与者出方案都失败 → 抛清晰聚合错误", async () => {
    const run: RunRole = vi.fn(async ({ config }) => {
      throw new Error(`模型「${config.modelName}」失败：Load failed`);
    });
    await expect(
      runDynamicDebate({ topic: "T", participants: [cfg("p1", "m-a"), cfg("p2", "m-b")] }, run),
    ).rejects.toThrow("所有参与模型都无法出方案");
  });

  it("中止信号在降级路径里仍然原样抛 AbortError", async () => {
    const run: RunRole = vi.fn(async () => {
      const e = new Error("AbortError");
      e.name = "AbortError";
      throw e;
    });
    await expect(
      runDynamicDebate({ topic: "T", participants: [cfg("p1", "m-a"), cfg("p2", "m-b")] }, run),
    ).rejects.toThrow("AbortError");
  });
});
