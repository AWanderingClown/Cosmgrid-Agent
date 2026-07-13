// chat-fallback-attempt 单元测试：只覆盖工具步数熔断重构新增的 priorToolCalls 拼接行为
// （doom-loop 跨续接批次判定，见 chat-fallback-attempt.ts 里 runModelAttempt 的注释）。
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({ streamText: vi.fn() }));

vi.mock("ai", () => ({ streamText: mocks.streamText, stepCountIs: (n: number) => n }));
vi.mock("../provider-factory", () => ({
  getLanguageModel: vi.fn(() => ({ __mock: true })),
}));
vi.mock("../db", () => ({ cliSessions: { upsert: vi.fn() } }));

import { runModelAttempt } from "../chat-fallback-attempt";
import type { ModelEndpoint } from "../chat-fallback-types";

const target: ModelEndpoint = {
  modelId: "m1",
  modelName: "model-1",
  providerType: "anthropic",
  providerId: "p1",
  apiCredentialId: "c1",
  apiKey: "k",
  baseUrl: "https://x",
};

/** 模拟 streamText 在一步内触发一次 onStepFinish（同名同参工具调用），然后立即 tool-calls 收尾。 */
function makeOneStepStream(toolCall: { toolName: string; input: unknown }) {
  return (args: { onStepFinish?: (e: { toolCalls: unknown[] }) => void }) => {
    args.onStepFinish?.({ toolCalls: [toolCall] });
    return {
      fullStream: (async function* () {})(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
      finishReason: Promise.resolve("tool-calls"),
    };
  };
}

describe("runModelAttempt - doom-loop 跨续接批次判定（priorToolCalls）", () => {
  it("本批只有 1 次调用，但拼上 priorToolCalls 后累计满 3 次相同调用 → 应该 abort", async () => {
    const call = { toolName: "edit", input: { path: "/a.ts" } };
    mocks.streamText.mockImplementationOnce(makeOneStepStream(call));

    const result = await runModelAttempt(
      target,
      [{ role: "user", content: "改完这个文件" }],
      { onDelta: () => {} },
      { tools: {} as never, maxToolSteps: 20 },
      [call, call], // 前两批已经是同一个调用；本批第 3 次命中应该跨批触发 doom-loop
    );

    expect(result.wasAborted).toBe(true);
  });

  it("不传 priorToolCalls（默认空数组）时只看本批内的调用，行为跟改造前一致", async () => {
    const call = { toolName: "edit", input: { path: "/a.ts" } };
    mocks.streamText.mockImplementationOnce(makeOneStepStream(call));

    const result = await runModelAttempt(
      target,
      [{ role: "user", content: "改完这个文件" }],
      { onDelta: () => {} },
      { tools: {} as never, maxToolSteps: 20 },
    );

    expect(result.wasAborted).toBe(false);
  });
});
