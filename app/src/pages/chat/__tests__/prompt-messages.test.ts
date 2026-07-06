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

  // 真实事故（2026-07-04）：模型上一轮回复"好，再试一次。"但 0 次真实工具调用，
  // 下一轮完全没有依据判断"上一轮到底做了什么"，只能瞎编。见 prompt-messages.ts
  // 的 buildLastTurnNoToolReminder。
  it("上一条 assistant 消息像重试意图但 toolCallCount=0 → 插入系统提醒", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", content: "看一下这个网站" },
      { id: "assistant-1", role: "assistant", content: "好，再试一次。", toolCallCount: 0 },
      { id: "user-2", role: "user", content: "？" },
    ];

    const prompt = buildChatPromptMessages({
      messages,
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("0 次真实工具调用"))).toBe(true);
  });

  it("上一条 assistant 消息 toolCallCount 未记录（undefined）→ 不插入提醒（漏报优于误报）", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", content: "看一下这个网站" },
      { id: "assistant-1", role: "assistant", content: "好，再试一次。" },
      { id: "user-2", role: "user", content: "？" },
    ];

    const prompt = buildChatPromptMessages({
      messages,
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("0 次真实工具调用"))).toBe(false);
  });

  it("上一条 assistant 消息真有工具调用（toolCallCount>0）→ 不插入提醒", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", content: "看一下这个网站" },
      { id: "assistant-1", role: "assistant", content: "好，再试一次。", toolCallCount: 2 },
      { id: "user-2", role: "user", content: "？" },
    ];

    const prompt = buildChatPromptMessages({
      messages,
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("0 次真实工具调用"))).toBe(false);
  });
});
