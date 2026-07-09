// chat-fallback 的恢复/推断相关纯函数，从 chat-fallback.ts 拆出（2026-07-09）。

import { classifyMessageComplexity } from "./message-router";
import type { ChatMsg } from "./context-compressor";

export function buildRecoveryMessages(messages: ChatMsg[], partialText: string, reason: string): ChatMsg[] {
  const trimmed = partialText.trim();
  const recovered: ChatMsg[] = [...messages];
  if (trimmed) {
    recovered.push({ role: "assistant", content: trimmed });
  }
  recovered.push({
    role: "user",
    content:
      `上一次模型调用因为「${reason}」没有正常完成。请从刚才中断处继续，不要重复已经完成的内容，` +
      "继续完成用户原始任务。如果前文已经给出部分答案，只补剩余部分。",
  });
  return recovered;
}

export function getPartialTextFromError(error: unknown): string {
  if (typeof error === "object" && error !== null && "__partialText" in error) {
    const partial = (error as { __partialText?: unknown }).__partialText;
    return typeof partial === "string" ? partial : "";
  }
  return "";
}

/** 从对话里取最后一条 user 消息推断难度桶（role 默认值）。兼容多模态 content（数组取 text part）。 */
export function inferRole(messages: ChatMsg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      const c = m.content;
      const text =
        typeof c === "string"
          ? c
          : c.filter((p) => p.type === "text").map((p) => ("text" in p ? p.text : "")).join("");
      return classifyMessageComplexity(text);
    }
  }
  return "main_chat";
}
