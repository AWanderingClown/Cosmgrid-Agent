import { describe, it, expect, vi, beforeEach } from "vitest";

const generateObjectMock = vi.fn();
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

import { generateCheckpointDraft } from "../checkpoint-generator";
import type { LanguageModel } from "../provider-factory";

const fakeModel = {} as LanguageModel;

const fakeDraft = {
  title: "前端组件 v1 完成",
  goal: "完成登录表单组件",
  completedSummary: "实现了表单 UI 和校验逻辑",
  currentContext: "后端接口尚未联调",
  decisions: "用 react-hook-form 而不是手写状态管理",
  failedAttempts: "",
  blockers: "",
  nextSteps: "联调登录接口",
  doNotRepeat: "",
  acceptanceCriteria: "登录接口联调通过，能正常登录",
};

describe("generateCheckpointDraft", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("调用 generateObject 并返回结构化草稿", async () => {
    generateObjectMock.mockResolvedValue({ object: fakeDraft });

    const result = await generateCheckpointDraft(fakeModel, [
      { role: "user", content: "帮我写个登录表单" },
      { role: "assistant", content: "好的，已经实现了表单 UI 和校验逻辑" },
    ]);

    expect(result).toEqual(fakeDraft);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const callArgs = generateObjectMock.mock.calls[0]![0] as { prompt: string; model: unknown };
    expect(callArgs.model).toBe(fakeModel);
    expect(callArgs.prompt).toContain("帮我写个登录表单");
    expect(callArgs.prompt).toContain("实现了表单 UI 和校验逻辑");
  });

  it("空对话历史也能生成占位草稿", async () => {
    generateObjectMock.mockResolvedValue({ object: fakeDraft });

    const result = await generateCheckpointDraft(fakeModel, []);

    expect(result).toEqual(fakeDraft);
    const callArgs = generateObjectMock.mock.calls[0]![0] as { prompt: string };
    expect(callArgs.prompt).toContain("这段对话还没有任何内容");
  });
});
