import { describe, it, expect, vi, beforeEach } from "vitest";

const generateObjectMock = vi.fn();
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

import { summarizeDroppedHistory } from "../history-summarizer";
import type { LanguageModel } from "../provider-factory";
import type { ChatMsg } from "../context-compressor";

const fakeModel = { modelId: "test-model" } as LanguageModel;

const fakeSummary = {
  summary: "用户实现登录表单，定了 react-hook-form，后端未联调",
  keyDecisions: ["用 react-hook-form 不用 Formik"],
  factsEstablished: ["登录接口尚未联调"],
  openThreads: ["后端接口待对接"],
};

describe("summarizeDroppedHistory", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("dropped 为空时直接返回 null，不调用 LLM", async () => {
    const result = await summarizeDroppedHistory([], fakeModel);
    expect(result).toBeNull();
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("调用 generateObject 并返回结构化摘要", async () => {
    generateObjectMock.mockResolvedValue({ object: fakeSummary });

    const dropped: ChatMsg[] = [
      { role: "user", content: "帮我写个登录表单" },
      { role: "assistant", content: "好的，用 react-hook-form 实现" },
    ];

    const result = await summarizeDroppedHistory(dropped, fakeModel);

    expect(result).toEqual(fakeSummary);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);

    const callArgs = generateObjectMock.mock.calls[0]![0] as {
      model: unknown;
      schema: unknown;
      maxOutputTokens: number;
      prompt: string;
    };
    expect(callArgs.model).toBe(fakeModel);
    expect(callArgs.schema).toBeDefined();
    expect(typeof callArgs.maxOutputTokens).toBe("number");
    expect(callArgs.prompt).toContain("帮我写个登录表单");
    expect(callArgs.prompt).toContain("用 react-hook-form 实现");
  });

  it("prompt 带忠实约束（不得编造），与 fabrication-judge 同一条哲学", async () => {
    generateObjectMock.mockResolvedValue({ object: fakeSummary });

    await summarizeDroppedHistory([{ role: "user", content: "x" }], fakeModel);

    const callArgs = generateObjectMock.mock.calls[0]![0] as { prompt: string };
    // 必须包含防编造纪律
    expect(callArgs.prompt).toMatch(/(不得|不要|不能).*(编造|补充|幻觉)/);
    expect(callArgs.prompt).toContain("忠实");
  });

  it("generateObject 抛错时返回 null，不阻断调用方", async () => {
    generateObjectMock.mockRejectedValue(new Error("network timeout"));

    const result = await summarizeDroppedHistory(
      [{ role: "user", content: "x" }],
      fakeModel,
    );

    expect(result).toBeNull();
  });

  it("全部字段都空时返回 null（让调用方退回抽取式）", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        summary: "",
        keyDecisions: [],
        factsEstablished: [],
        openThreads: [],
      },
    });

    const result = await summarizeDroppedHistory(
      [{ role: "user", content: "x" }],
      fakeModel,
    );

    expect(result).toBeNull();
  });

  it("单条消息超过 2000 字时截断（避免 prompt 过长）", async () => {
    generateObjectMock.mockResolvedValue({ object: fakeSummary });

    const longContent = "a".repeat(5000);
    await summarizeDroppedHistory(
      [{ role: "user", content: longContent }],
      fakeModel,
    );

    const callArgs = generateObjectMock.mock.calls[0]![0] as { prompt: string };
    // prompt 里的内容应该被截断到 2000 + ellipsis，不应该包含全部 5000 字
    expect(callArgs.prompt).not.toContain("a".repeat(3000));
    expect(callArgs.prompt).toContain("…");
  });

  it("多模态内容（数组）渲染为占位，不抛错", async () => {
    generateObjectMock.mockResolvedValue({ object: fakeSummary });

    const dropped: ChatMsg[] = [
      { role: "user", content: [{ type: "image", image: "fakebase64" }] },
      { role: "assistant", content: "看到图了" },
    ];

    const result = await summarizeDroppedHistory(dropped, fakeModel);

    expect(result).toEqual(fakeSummary);
    const callArgs = generateObjectMock.mock.calls[0]![0] as { prompt: string };
    expect(callArgs.prompt).toContain("[多模态内容]");
    expect(callArgs.prompt).toContain("看到图了");
  });
});
