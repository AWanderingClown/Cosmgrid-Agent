// 阶段4 — Runner × LLM judge 集成测试。
//
// 验证 runEvalCase 在 deterministic graders 之后接入 llmJudgeSoftCriteria：
// - case 有 assistantOutput → 调 judge，fabrication 一票否决
// - case 无 assistantOutput → 向后兼容，不调 judge
// - judge inconclusive（null）不翻案
//
// 用空 acceptanceCriteria 隔离 judge 对最终 passed 的影响（不受 deterministic grader 干扰）。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  // 设了就替换 getGrader（测 grader 抛错路径用）；undefined = 透传真实现
  getGraderOverride: undefined as ((name: string) => unknown) | undefined,
}));

vi.mock("ai", () => ({
  generateObject: mocks.generateObject,
}));

vi.mock("../graders", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../graders")>();
  return {
    ...orig,
    getGrader: (name: string) =>
      mocks.getGraderOverride ? mocks.getGraderOverride(name) : orig.getGrader(name),
  };
});

const { runEvalCase } = await import("../runner");
import type { EvalCase, RunnerConfig } from "../types";

const judgeModel = { modelId: "judge-model" } as unknown;

function baseCase(over: Partial<EvalCase>): EvalCase {
  return {
    id: "t-judge",
    taskSetId: "held-in",
    name: "judge 集成用例",
    fixturePath: "n/a",
    permissionProfile: "default",
    acceptanceCriteria: [],
    createdAt: "2026-07-16T00:00:00.000Z",
    ...over,
  };
}

function cfg(over: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    taskSetId: "held-in",
    modelId: "m1",
    harnessVersion: "v1",
    maxAttempts: 1,
    ...over,
  };
}

describe("runEvalCase × llm-judge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("A 档：assistantOutput + toolCallCount=0 → judge 否决，passed=false", async () => {
    const out = await runEvalCase({
      caseRef: baseCase({
        assistantOutput: "我跑了 pnpm test，全部通过。",
        toolCallCount: 0,
      }),
      config: cfg({ judgeModel }),
    });
    expect(out.passed).toBe(false);
    const judgeEntry = out.graded[0]?.find((g) => g.grader === "llm-judge");
    expect(judgeEntry).toBeDefined();
    expect(judgeEntry?.result.ok).toBe(false);
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("向后兼容：无 assistantOutput → 不调 judge，无 llm-judge 记录", async () => {
    const out = await runEvalCase({
      caseRef: baseCase({}),
      config: cfg({ judgeModel }),
    });
    const judgeEntry = out.graded[0]?.find((g) => g.grader === "llm-judge");
    expect(judgeEntry).toBeUndefined();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("B 档：judge 认可（fabricated=false）→ 无 deterministic 判据时 passed=true", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { fabricated: false, confidence: 0.9, reason: "证据支持。", claimedActions: [] },
    });
    const out = await runEvalCase({
      caseRef: baseCase({
        assistantOutput: "我读了 foo.ts，里面 count=2。",
        toolCallCount: 2,
      }),
      config: cfg({ judgeModel }),
    });
    expect(out.passed).toBe(true);
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
  });

  it("judge inconclusive（无 judgeModel）→ 不翻案，passed 保持 null", async () => {
    const out = await runEvalCase({
      caseRef: baseCase({
        assistantOutput: "我读了 foo.ts。",
        toolCallCount: 2,
      }),
      config: cfg({ judgeModel: undefined }),
    });
    expect(out.passed).toBeNull();
    const judgeEntry = out.graded[0]?.find((g) => g.grader === "llm-judge");
    expect(judgeEntry?.result.detail).toContain("[inconclusive，不计入判定]");
  });
});

describe("runEvalCase grader 抛错不翻案", () => {
  it("grader fail 后另一 grader 抛错 + judge 认可 → passed 仍是 false（不被洗白）", async () => {
    // 原 bug：catch 分支无条件 attemptPassed=null，把已判的 false 洗成 inconclusive，
    // judge 认可（fabricated=false）再把 null 提升成 true —— 失败被两步洗白。
    mocks.generateObject.mockResolvedValue({
      object: { fabricated: false, confidence: 0.9, reason: "证据支持。", claimedActions: [] },
    });
    const failGrader = vi.fn().mockResolvedValue({ ok: false, detail: "判据不满足" });
    const throwGrader = vi.fn().mockRejectedValue(new Error("grader 内部炸了"));
    mocks.getGraderOverride = (name) => (name === "g-fail" ? failGrader : throwGrader);
    try {
      const out = await runEvalCase({
        caseRef: baseCase({
          acceptanceCriteria: [
            { grader: "g-fail", expected: {} },
            { grader: "g-throw", expected: {} },
          ],
          assistantOutput: "我读了 foo.ts，里面 count=2。",
          toolCallCount: 2,
        }),
        config: cfg({ judgeModel }),
      });
      expect(out.passed).toBe(false);
    } finally {
      mocks.getGraderOverride = undefined;
    }
  });
});

// 回归防线：EvalCaseSchema（fixture-loader）漏声明字段时 zod 会静默剥离，
// 内存对象测试抓不到——必须走真实 JSON 文件 round-trip（2026-07-17 复检抓到的 HIGH）。
describe("runEvalCase × llm-judge（真实 fixture round-trip）", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-judge-fixture-"));

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fixture JSON 的 assistantOutput/toolCallCount 经 loadEvalCase 存活，A 档否决 deterministic 通过的 case", async () => {
    const dataFile = join(dir, "data.txt");
    writeFileSync(dataFile, "hello eval");
    const casePath = join(dir, "case.json");
    writeFileSync(
      casePath,
      JSON.stringify({
        id: "rt-judge",
        taskSetId: "held-in",
        name: "round-trip judge 用例",
        fixturePath: dataFile,
        acceptanceCriteria: [{ grader: "filesystem", expected: { path: "data.txt" } }],
        assistantOutput: "我跑了 pnpm test，全部通过。",
        toolCallCount: 0,
      }),
    );
    const out = await runEvalCase({ caseRef: casePath, config: cfg({ judgeModel }) });
    // filesystem grader ok，但 judge A 档（0 工具调用 + 声称执行）一票否决
    expect(out.passed).toBe(false);
    const judgeEntry = out.graded[0]?.find((g) => g.grader === "llm-judge");
    expect(judgeEntry).toBeDefined();
    expect(judgeEntry?.result.ok).toBe(false);
  });
});
