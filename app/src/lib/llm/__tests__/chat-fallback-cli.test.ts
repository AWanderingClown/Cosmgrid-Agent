import { describe, expect, it, vi, beforeEach } from "vitest";
import { _resetCooldowns } from "../model-cooldown";

const mocks = vi.hoisted(() => ({
  streamViaCli: vi.fn(),
  streamText: vi.fn(),
  recordUsageEvent: vi.fn(),
}));

vi.mock("ai", () => ({ streamText: mocks.streamText, stepCountIs: (n: number) => n }));
vi.mock("../cli-engine", () => ({ streamViaCli: mocks.streamViaCli }));
vi.mock("../provider-factory", () => ({
  getLanguageModel: vi.fn((type: string) => ({ __mock: true, type })),
}));
vi.mock("../usage-tracker", () => ({
  recordUsageEvent: mocks.recordUsageEvent,
}));

import { streamWithFallback, type ModelEndpoint } from "../chat-fallback";

const cliPrimary: ModelEndpoint = {
  modelId: "m-claude-cli",
  modelName: "claude-sonnet",
  providerType: "claude-cli",
  providerId: "prov-cli",
  apiCredentialId: "cred-cli",
  apiKey: "unused",
  displayLabel: "Claude CLI",
};

const apiFallback: ModelEndpoint = {
  modelId: "m-api",
  modelName: "api-model",
  providerType: "openai",
  providerId: "prov-api",
  apiCredentialId: "cred-api",
  apiKey: "sk-test",
  displayLabel: "API",
};

// C 档第2步（2026-07-12）：生产代码改读 result.fullStream，mock 要跟着提供。
function makeSuccessStream(deltas: string[]) {
  return {
    textStream: (async function* () {
      for (const d of deltas) yield d;
    })(),
    fullStream: (async function* () {
      for (const d of deltas) yield { type: "text-delta" as const, id: "0", text: d };
    })(),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 2 }),
    finishReason: Promise.resolve("stop"),
  };
}

describe("streamWithFallback - CLI 非用户中断恢复", () => {
  beforeEach(() => {
    _resetCooldowns();
    mocks.streamViaCli.mockReset();
    mocks.streamText.mockReset();
    mocks.recordUsageEvent.mockReset();
  });

  it("CLI 输出一半后异常退出时，fallback 带上已输出片段继续", async () => {
    mocks.streamViaCli.mockImplementationOnce(async (_endpoint, _messages, callbacks) => {
      callbacks.onDelta("CLI 已经完成一半。");
      throw new Error("CLI exited with code 1");
    });
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["API 继续完成。"]));

    const deltas: string[] = [];
    const result = await streamWithFallback(
      [cliPrimary, apiFallback],
      [{ role: "user", content: "完成任务" }],
      { onDelta: (d) => deltas.push(d) },
    );

    expect(result).toEqual({ usedModelId: "m-api", switched: true });
    expect(deltas.join("")).toBe("CLI 已经完成一半。API 继续完成。");
    const fallbackCall = mocks.streamText.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(fallbackCall.messages.some((m) => m.role === "assistant" && m.content === "CLI 已经完成一半。")).toBe(true);
    expect(fallbackCall.messages.at(-1)?.content).toContain("不要重复已经完成的内容");
  });

  it("CLI 暴露官方 session id 且截断时，优先原生续跑，不直接切 API fallback", async () => {
    let cliCalls = 0;
    mocks.streamViaCli.mockImplementation(async (_endpoint, _messages, callbacks) => {
      cliCalls += 1;
      callbacks.onSession?.("sess-1");
      // C 档第1步（2026-07-12）之后 chat-fallback.ts 会校验可见正文是否为空——真实 CLI
      // 流一定会吐出实际文本，mock 也要跟着模拟，否则会被"内容为空"判定成截断触发
      // 额外一轮重试，制造跟真实场景不符的调用次数。
      callbacks.onDelta(cliCalls === 1 ? "第一段。" : "第二段。");
      return cliCalls === 1
        ? {
            inputTokens: 10,
            outputTokens: 20,
            finishReason: "length",
            officialSessionId: "sess-1",
          }
        : {
            inputTokens: 5,
            outputTokens: 8,
            finishReason: "stop",
            officialSessionId: "sess-1",
          };
    });
    mocks.streamText.mockReturnValue(makeSuccessStream(["不该走到 API fallback。"]));

    const deltas: string[] = [];
    const recovered: string[] = [];
    const result = await streamWithFallback(
      [cliPrimary, apiFallback],
      [{ role: "user", content: "完成任务" }],
      {
        onDelta: (d) => deltas.push(d),
        onRecovered: (mode) => recovered.push(mode),
      },
    );

    expect(mocks.streamViaCli).toHaveBeenCalledTimes(2);
    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(recovered).toContain("native_resume");
    // 原来这里断言的是 ""——纯粹是旧 mock 从不调用 onDelta 的副产品，不是这个测试
    // 真正要验证的行为（它验证的是"优先原生续跑、不切 API fallback"）。mock 补上真实
    // delta 后，这里改成校验两段真实吐出的文本被正确拼接。
    expect(deltas.join("")).toBe("第一段。第二段。");
    expect(result).toEqual({ usedModelId: "m-claude-cli", switched: false });
  });
});
