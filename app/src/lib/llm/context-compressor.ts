// v0.9 阶段7 — 上下文压缩（长对话省 token）
//
// 当对话历史过长，把较早的消息裁掉，只发最近的给模型——省 token。
// 这一版用「确定性抽取式裁剪」（零成本、零延迟、可预测）：
//   - system 消息始终保留
//   - 从最新往回保留，直到接近 token 预算
//   - 若有裁掉，插一条 system 提示"前 N 条较早消息已省略"
// LLM 摘要版（保留关键决策再压缩）留到 v0.9.1。

import type { UserContentPart } from "./attachments";

export interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string | UserContentPart[];
}

/** 粗略 token 估算：CJK 约 1 token/字，拉丁约 1 token/4 字符。取折中 chars/3。
 *  兼容多模态 content（数组）：text part 按 chars/3，每图固定估 1000 token（base64 占位粗估）。 */
export function estimateTokens(content: string | UserContentPart[]): number {
  if (typeof content === "string") return Math.ceil(content.length / 3);
  let len = 0;
  let images = 0;
  for (const p of content) {
    if (p.type === "text") len += p.text.length;
    else images++;
  }
  return Math.ceil(len / 3) + images * 1000;
}

export function estimateMessagesTokens(messages: ChatMsg[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

export interface CompressResult {
  messages: ChatMsg[];
  compressed: boolean;
  droppedCount: number;
}

export interface CompressOptions {
  /** token 预算（保留消息估算总 token 的上限），默认 12000 */
  maxTokens?: number;
  /** 至少保留最近多少条非 system 消息（避免裁太狠），默认 4 */
  minRecent?: number;
  /** 省略提示文案构造（i18n 由调用方注入），默认中性英文 */
  noticeText?: (dropped: number) => string;
}

/**
 * 压缩对话历史。不修改入参（返回新数组）。
 * system 消息全保留；其余从最新往回收，直到超预算或只剩 minRecent。
 */
export function compressHistory(messages: ChatMsg[], opts: CompressOptions = {}): CompressResult {
  const maxTokens = opts.maxTokens ?? 12000;
  const minRecent = opts.minRecent ?? 4;
  const noticeText = opts.noticeText ?? ((n: number) => `[${n} earlier messages omitted to save tokens]`);

  // 在预算内：原样返回
  if (estimateMessagesTokens(messages) <= maxTokens) {
    return { messages: [...messages], compressed: false, droppedCount: 0 };
  }

  const systemMsgs = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const systemTokens = estimateMessagesTokens(systemMsgs);
  let budget = maxTokens - systemTokens;

  // 从最新往回保留
  const kept: ChatMsg[] = [];
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const m = nonSystem[i]!;
    const cost = estimateTokens(m.content) + 4;
    if (kept.length < minRecent || budget - cost >= 0) {
      kept.unshift(m);
      budget -= cost;
    } else {
      break;
    }
  }

  const droppedCount = nonSystem.length - kept.length;
  if (droppedCount <= 0) {
    return { messages: [...messages], compressed: false, droppedCount: 0 };
  }

  const notice: ChatMsg = { role: "system", content: noticeText(droppedCount) };
  return {
    messages: [...systemMsgs, notice, ...kept],
    compressed: true,
    droppedCount,
  };
}
