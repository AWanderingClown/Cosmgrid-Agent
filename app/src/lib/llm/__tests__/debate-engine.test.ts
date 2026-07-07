// debate-engine 单测（v0.8 阶段5：对弈编排 + 多轮收敛）
import { describe, it, expect, vi } from "vitest";
import {
  runDynamicDebate,
  solverSystemPrompt,
  criticSystemPrompt,
  judgeSystemPrompt,
  parseJudgeDecision,
  dynamicProposalRevisionUserPrompt,
  type RunRole,
  type DebateRoleConfig,
} from "../debate-engine";

function cfg(role: DebateRoleConfig["role"], modelId: string): DebateRoleConfig {
  return {
    role, modelId, modelName: `${modelId}-name`, providerType: "anthropic",
    providerId: "prov-1", apiCredentialId: "cred-1", apiKey: "k",
  };
}

/** 构造一个合法的 Judge JSON 输出 */
function judgeJson(approved: boolean, feedback: string[] = [], solution = "最终方案"): string {
  return JSON.stringify({ approved, feedback, finalSolution: solution });
}

// 假 runRole：按角色配置返回可识别内容，并记录每次调用
// judge 角色返回合法 JSON（approved=true），其它角色返回纯文本
function makeRunRole(opts?: { judgeApproved?: boolean; judgeFeedback?: string[] }) {
  const calls: { role: string; systemPrompt: string; userPrompt: string }[] = [];
  const run: RunRole = vi.fn(async ({ systemPrompt, userPrompt, config }) => {
    calls.push({ role: config.role, systemPrompt, userPrompt });
    if (config.role === "judge") {
      return {
        content: judgeJson(opts?.judgeApproved ?? true, opts?.judgeFeedback ?? []),
        inputTokens: 10,
        outputTokens: 20,
      };
    }
    return { content: `${config.role}-output`, inputTokens: 10, outputTokens: 20 };
  });
  return { run, calls };
}

// ============================================================
// parseJudgeDecision 测试
// ============================================================
describe("parseJudgeDecision", () => {
  it("解析纯 JSON 字符串", () => {
    const input = '{"approved": true, "feedback": ["好"], "finalSolution": "最终方案"}';
    const result = parseJudgeDecision(input);
    expect(result).toEqual({ approved: true, feedback: ["好"], finalSolution: "最终方案" });
  });

  it("解析 markdown code fence 包裹的 JSON", () => {
    const input = '一些废话\n```json\n{"approved": false, "feedback": ["问题1", "问题2"], "finalSolution": "修正方案"}\n```\n更多废话';
    const result = parseJudgeDecision(input);
    expect(result).toEqual({ approved: false, feedback: ["问题1", "问题2"], finalSolution: "修正方案" });
  });

  it("JSON 格式完全无效时走启发式 fallback，默认 approved=false", () => {
    const input = "这是一段完全非结构化的裁判意见，没有 JSON 格式。";
    const result = parseJudgeDecision(input);
    expect(result.approved).toBe(false);
    expect(result.finalSolution).toBe("");
  });

  it("启发式提取 approved=true", () => {
    const input = "approved: true\nfeedback: []\nfinalSolution: \"没问题\"";
    const result = parseJudgeDecision(input);
    expect(result.approved).toBe(true);
  });

  it("JSON 中字段类型不对时走 fallback", () => {
    const input = '{"approved": "yes", "feedback": "不是数组", "finalSolution": 123}';
    const result = parseJudgeDecision(input);
    // approved 不是 boolean → fallback
    expect(result.approved).toBe(false);
  });
});

// ============================================================
// dynamicProposalRevisionUserPrompt 测试
// ============================================================
describe("dynamicProposalRevisionUserPrompt", () => {
  it("包含话题、上一次方案、批评和裁判反馈", () => {
    const prompt = dynamicProposalRevisionUserPrompt({
      topic: "测试话题",
      previousSolution: "上一次方案内容",
      critiques: [{ role: "critic", modelId: "m-b", content: "漏洞1", inputTokens: 1, outputTokens: 1 }],
      judgeFeedback: ["建议改进点A"],
    });
    expect(prompt).toContain("测试话题");
    expect(prompt).toContain("上一次方案内容");
    expect(prompt).toContain("漏洞1");
    expect(prompt).toContain("建议改进点A");
    expect(prompt).toContain("修正后的方案");
  });
});

// ============================================================
// runDynamicDebate — 动态参与模型（核心流程）
// ============================================================
describe("runDynamicDebate — 动态参与模型", () => {
  it("把 abort signal 透传给每个参与角色", async () => {
    const controller = new AbortController();
    const seenSignals: (AbortSignal | undefined)[] = [];
    const run: RunRole = vi.fn(async ({ signal, config }) => {
      seenSignals.push(signal);
      if (config.role === "judge") {
        return { content: judgeJson(true), inputTokens: 1, outputTokens: 1 };
      }
      return { content: `${config.role}-output`, inputTokens: 1, outputTokens: 1 };
    });

    await runDynamicDebate({
      topic: "比较两个实现方案",
      participants: [cfg("solver", "m-a"), cfg("critic", "m-b")],
      maxIterations: 1,
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
      maxIterations: 1,
      signal: controller.signal,
    }, run)).rejects.toThrow("AbortError");

    expect(calls).toEqual(["solver"]);
  });

  it("只有 1 个模型时做单模型自审", async () => {
    const { run, calls } = makeRunRole();
    const r = await runDynamicDebate({
      topic: "方案是否可行",
      participants: [cfg("solver", "m-only")],
    }, run);

    expect(r.rounds.map((x) => x.role)).toEqual(["solo_review"]);
    expect(calls).toHaveLength(1);
  });

  it("2 个模型时 A 出方案、B 反驳、A 裁决", async () => {
    const { run, calls } = makeRunRole();
    const r = await runDynamicDebate({
      topic: "比较两个实现方案",
      participants: [cfg("solver", "m-a"), cfg("critic", "m-b")],
      maxIterations: 1,
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
      maxIterations: 1,
    }, run);

    expect(r.rounds.map((x) => x.role)).toEqual(["solver", "critic", "critic_2", "judge"]);
    expect(r.rounds.map((x) => x.modelId)).toEqual(["m-a", "m-b", "m-c", "m-d"]);
  });
});

// ============================================================
// prompt 构造
// ============================================================
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

  it("judge prompt 要求返回 JSON 格式", () => {
    const prompt = judgeSystemPrompt();
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("approved");
    expect(prompt).toContain("feedback");
    expect(prompt).toContain("finalSolution");
  });
});

// ============================================================
// 多轮收敛循环
// ============================================================
describe("runDynamicDebate 多轮收敛循环", () => {
  it("Judge approved=true 时一轮就结束", async () => {
    const { run, calls } = makeRunRole({ judgeApproved: true });
    const r = await runDynamicDebate({
      topic: "测试",
      participants: [cfg("solver", "m-a"), cfg("critic", "m-b")],
      maxIterations: 3,
    }, run);

    // 只跑了一轮：solver + critic + judge
    expect(r.rounds.map((x) => x.role)).toEqual(["solver", "critic", "judge"]);
    expect(calls).toHaveLength(3);
  });

  it("Judge approved=false 时进入修正循环直到 approved=true", async () => {
    let judgeCallCount = 0;
    const calls: string[] = [];
    const run: RunRole = vi.fn(async ({ config }) => {
      calls.push(config.role);
      if (config.role === "judge") {
        judgeCallCount++;
        // 第一次不通过，第二次通过
        const approved = judgeCallCount >= 2;
        return {
          content: judgeJson(approved, approved ? [] : ["要改进"]),
          inputTokens: 10,
          outputTokens: 20,
        };
      }
      return { content: `${config.role}-output`, inputTokens: 10, outputTokens: 20 };
    });

    const r = await runDynamicDebate({
      topic: "测试多轮",
      participants: [cfg("solver", "m-a"), cfg("critic", "m-b")],
      maxIterations: 3,
    }, run);

    // 第一轮：solver + critic + judge(不通过)
    // 第二轮：solver(修正) + critic + judge(通过)
    expect(r.rounds.map((x) => x.role)).toEqual([
      "solver", "critic", "judge",
      "solver", "critic", "judge",
    ]);
    expect(judgeCallCount).toBe(2);
  });

  it("达到 maxIterations 上限后停止循环，即使未 approved", async () => {
    const calls: string[] = [];
    const run: RunRole = vi.fn(async ({ config }) => {
      calls.push(config.role);
      if (config.role === "judge") {
        // 永远不通过
        return {
          content: judgeJson(false, ["还是不行"]),
          inputTokens: 10,
          outputTokens: 20,
        };
      }
      return { content: `${config.role}-output`, inputTokens: 10, outputTokens: 20 };
    });

    const r = await runDynamicDebate({
      topic: "测试上限",
      participants: [cfg("solver", "m-a"), cfg("critic", "m-b")],
      maxIterations: 2,
    }, run);

    // 正好跑 2 轮就停
    const judgeRounds = r.rounds.filter((x) => x.role === "judge");
    expect(judgeRounds).toHaveLength(2);
    // finalSolution 非空（用 judge 给出的或 solver 方案兜底）
    expect(r.finalSolution).toBeTruthy();
  });

  it("修正轮的 solver userPrompt 包含上一轮的 feedback", async () => {
    let judgeCallCount = 0;
    const solverPrompts: string[] = [];
    const run: RunRole = vi.fn(async ({ config, userPrompt }) => {
      if (config.role === "solver") {
        solverPrompts.push(userPrompt);
      }
      if (config.role === "judge") {
        judgeCallCount++;
        return {
          content: judgeJson(judgeCallCount >= 2, judgeCallCount < 2 ? ["加密必须用 AES-256"] : []),
          inputTokens: 10,
          outputTokens: 20,
        };
      }
      return { content: `${config.role}-output`, inputTokens: 10, outputTokens: 20 };
    });

    await runDynamicDebate({
      topic: "安全方案",
      participants: [cfg("solver", "m-a"), cfg("critic", "m-b")],
      maxIterations: 3,
    }, run);

    // 第一轮 solver prompt 不含 feedback
    expect(solverPrompts[0]).not.toContain("加密必须用 AES-256");
    // 第二轮 solver prompt 应包含 judge 的 feedback
    expect(solverPrompts[1]).toContain("加密必须用 AES-256");
  });
});

// ============================================================
// 降级（单参与者失败不全挂）
// ============================================================
describe("runDynamicDebate 降级（单参与者失败不全挂）", () => {
  it("proposer 失败 → 换下一个参与者顶上出方案，失败明细不污染最终方案", async () => {
    const calls: string[] = [];
    const run: RunRole = vi.fn(async ({ config }) => {
      calls.push(`${config.modelId}:${config.role}`);
      if (config.modelId === "m-a" && config.role === "solver") {
        throw new Error("模型「m-a-name」（solver）调用失败：Load failed");
      }
      if (config.role === "judge") {
        return { content: judgeJson(true), inputTokens: 1, outputTokens: 2 };
      }
      return { content: `${config.modelId}-${config.role}`, inputTokens: 1, outputTokens: 2 };
    });
    const r = await runDynamicDebate(
      { topic: "T", participants: [cfg("p1", "m-a"), cfg("p2", "m-b"), cfg("p3", "m-c")], maxIterations: 1 },
      run,
    );
    // m-a 出方案失败 → m-b 顶上当 solver，最终能产出
    expect(r.rounds.find((x) => x.role === "solver")?.modelId).toBe("m-b");
    expect(r.failures).toHaveLength(1);
    expect(r.finalSolution).not.toContain("失败");
  });

  it("critic 失败 → 跳过它，judge 仍产出最终方案", async () => {
    const run: RunRole = vi.fn(async ({ config }) => {
      if (config.role === "critic") throw new Error("模型「x」（critic）调用失败：boom");
      if (config.role === "judge") {
        return { content: judgeJson(true), inputTokens: 1, outputTokens: 2 };
      }
      return { content: `${config.modelId}-${config.role}`, inputTokens: 1, outputTokens: 2 };
    });
    const r = await runDynamicDebate(
      { topic: "T", participants: [cfg("p1", "m-a"), cfg("p2", "m-b"), cfg("p3", "m-c")], maxIterations: 1 },
      run,
    );
    expect(r.rounds.some((x) => x.role === "judge")).toBe(true);
    expect(r.failures).toHaveLength(1);
    expect(r.finalSolution).not.toContain("boom");
  });

  it("全部参与者出方案都失败 → 抛用户能看懂的错误，内部保留明细", async () => {
    const run: RunRole = vi.fn(async ({ config }) => {
      throw new Error(`模型「${config.modelName}」失败：Load failed`);
    });
    await expect(
      runDynamicDebate({ topic: "T", participants: [cfg("p1", "m-a"), cfg("p2", "m-b")], maxIterations: 1 }, run),
    ).rejects.toThrow("当前参与博弈的模型都没有成功响应");
    try {
      await runDynamicDebate(
        { topic: "T", participants: [cfg("p1", "m-a"), cfg("p2", "m-b")], maxIterations: 1 },
        run,
      );
    } catch (err) {
      expect((err as { debateFailures?: string[] }).debateFailures).toHaveLength(2);
    }
  });

  it("中止信号在降级路径里仍然原样抛 AbortError", async () => {
    const run: RunRole = vi.fn(async () => {
      const e = new Error("AbortError");
      e.name = "AbortError";
      throw e;
    });
    await expect(
      runDynamicDebate({ topic: "T", participants: [cfg("p1", "m-a"), cfg("p2", "m-b")], maxIterations: 1 }, run),
    ).rejects.toThrow("AbortError");
  });

  it("judge 失败 → 用 solver 方案兜底，不让整场崩", async () => {
    const run: RunRole = vi.fn(async ({ config }) => {
      if (config.role === "judge") {
        throw new Error("judge 炸了");
      }
      return { content: `${config.role}-output`, inputTokens: 1, outputTokens: 2 };
    });
    const r = await runDynamicDebate(
      { topic: "T", participants: [cfg("p1", "m-a"), cfg("p2", "m-b")], maxIterations: 1 },
      run,
    );
    // 没有 judge round（失败了），但仍然有 finalSolution
    expect(r.rounds.some((x) => x.role === "judge")).toBe(false);
    expect(r.finalSolution).toContain("solver-output");
    expect(r.failures).toHaveLength(1);
    expect(r.finalSolution).not.toContain("judge 炸了");
  });
});
