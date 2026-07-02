import { describe, expect, it } from "vitest";
import { buildChatPromptMessages } from "../prompt-messages";
import type { ChatMessage } from "../types";

function textContent(content: unknown): string {
  return typeof content === "string" ? content : "";
}

describe("buildChatPromptMessages", () => {
  it("keeps receipt messages out of the model prompt and adds no-tools guard for API chats without workspace", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", content: "解释一下这个问题" },
      { id: "receipt-1", role: "assistant", content: "内部回执", kind: "receipt" },
      { id: "assistant-1", role: "assistant", content: "上一轮回答" },
    ];

    const prompt = buildChatPromptMessages({
      messages,
      effectiveWorkspace: null,
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.some((m) => textContent(m.content).includes("内部回执"))).toBe(false);
    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("没有接入任何工具"))).toBe(true);
    expect(prompt.at(-2)).toEqual({ role: "user", content: "解释一下这个问题" });
    expect(prompt.at(-1)).toEqual({ role: "assistant", content: "上一轮回答" });
  });

  it("adds workspace guards and omits no-tools guard when a workspace is bound", () => {
    const prompt = buildChatPromptMessages({
      messages: [{ id: "user-1", role: "user", content: "读一下项目" }],
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: "项目记忆",
      crossProjectPreamble: "跨项目记忆",
      workspacePreamble: "工作区说明",
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.map((m) => textContent(m.content))).toEqual(
      expect.arrayContaining(["项目记忆", "跨项目记忆", "工作区说明"]),
    );
    expect(prompt.some((m) => textContent(m.content).includes("图片"))).toBe(true);
    expect(prompt.some((m) => textContent(m.content).includes("没有接入任何工具"))).toBe(false);
  });
});
