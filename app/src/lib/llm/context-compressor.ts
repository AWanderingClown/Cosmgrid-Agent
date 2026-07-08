// v0.9 阶段7 — 上下文压缩（长对话省 token）
//
// 当对话历史过长，把较早的消息裁掉，只发最近的给模型——省 token。
// 两套实现互补：
//   - `compressHistory`（v0.9）—— 确定性抽取式裁剪（零成本、零延迟、可预测）
//     system 消息始终保留；从最新往回保留，直到接近 token 预算；
//     若有裁掉，插一条 system 提示"前 N 条较早消息已省略"。
//   - `compressHistoryWithSummary`（v0.9.1）—— 摘要式压缩（v0.9.1 起）
//     先用同样的预算逻辑定位"要丢哪些消息（dropped）"，再调一次 LLM 把 dropped
//     浓缩成结构化摘要文本，把摘要文本作为一条 system 消息插到 system 之后、kept 之前。
//     摘要不可用（生成失败 / 返回 null）时退回抽取式，保证体验不比现在差。
//
// 两者共用 `splitByBudget` 定位 kept/dropped，避免预算逻辑漂移。

import type { UserContentPart } from "./attachments";
import { DEFAULT_COMPRESSION_BUDGET } from "./model-limits";

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
  beforeTokens: number;
  afterTokens: number;
}

export interface CompressOptions {
  /** token 预算（保留消息估算总 token 的上限），默认 12000 */
  maxTokens?: number;
  /** 至少保留最近多少条非 system 消息（避免裁太狠），默认 4 */
  minRecent?: number;
  /** 省略提示文案构造（i18n 由调用方注入），默认中性英文 */
  noticeText?: (dropped: number) => string;
}

/** 模块级默认提示文案——和 splitByBudget 共享给两套压缩路径用 */
const DEFAULT_NOTICE_TEXT = (n: number): string => `[${n} earlier messages omitted to save tokens]`;

/**
 * 把 systemMsgs + notice + kept 拼成最终输出，统一给两套压缩路径用。
 */
function buildCompressedOutput(
  systemMsgs: ChatMsg[],
  kept: ChatMsg[],
  noticeContent: string,
  beforeTokens: number,
  droppedCount: number,
): CompressResult {
  const notice: ChatMsg = { role: "system", content: noticeContent };
  const messages = [...systemMsgs, notice, ...kept];
  return {
    messages,
    compressed: true,
    droppedCount,
    beforeTokens,
    afterTokens: estimateMessagesTokens(messages),
  };
}

/**
 * 内部共用：按 token 预算把消息切成「保留 / 丢弃」两组。
 * 返回的 `messages` 不可变（两份切片都不修改原数组）。
 * - 预算内 → 全部归 kept、dropped 为空
 * - 超出预算 → system 全保留；从最新往回保留直到预算耗尽或只剩 minRecent
 */
function splitByBudget(
  messages: ChatMsg[],
  maxTokens: number,
  minRecent: number,
): { systemMsgs: ChatMsg[]; kept: ChatMsg[]; dropped: ChatMsg[]; compressed: boolean } {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  const systemTokens = estimateMessagesTokens(systemMsgs);

  // 预算内：全部保留，无丢弃
  if (estimateMessagesTokens(messages) <= maxTokens) {
    return { systemMsgs, kept: [...nonSystem], dropped: [], compressed: false };
  }

  let budget = maxTokens - systemTokens;
  const kept: ChatMsg[] = [];
  let dropStartIndex = nonSystem.length;

  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const m = nonSystem[i]!;
    const cost = estimateTokens(m.content) + 4;
    if (kept.length < minRecent || budget - cost >= 0) {
      kept.unshift(m);
      budget -= cost;
    } else {
      dropStartIndex = i + 1;
      break;
    }
  }

  const dropped = nonSystem.slice(0, dropStartIndex);
  return { systemMsgs, kept, dropped, compressed: dropped.length > 0 };
}

/**
 * 压缩对话历史（抽取式裁剪）。不修改入参（返回新数组）。
 * system 消息全保留；其余从最新往回收，直到超预算或只剩 minRecent。
 */
export function compressHistory(messages: ChatMsg[], opts: CompressOptions = {}): CompressResult {
  const maxTokens = opts.maxTokens ?? DEFAULT_COMPRESSION_BUDGET;
  const minRecent = opts.minRecent ?? 4;
  const noticeText = opts.noticeText ?? DEFAULT_NOTICE_TEXT;
  const beforeTokens = estimateMessagesTokens(messages);

  const { systemMsgs, kept, dropped, compressed } = splitByBudget(messages, maxTokens, minRecent);

  if (!compressed) {
    return { messages: [...messages], compressed: false, droppedCount: 0, beforeTokens, afterTokens: beforeTokens };
  }

  return buildCompressedOutput(systemMsgs, kept, noticeText(dropped.length), beforeTokens, dropped.length);
}

/**
 * 压缩对话历史（摘要式，v0.9.1）。
 * 同样的预算逻辑定位 dropped；若 `summarize` 注入且有 dropped，对 dropped 调一次
 * LLM 拿摘要文本，把摘要文本作为一条 system 消息插到 systemMsgs 之后、kept 之前
 * ——取代原来的"N 条已省略"纯提示。
 *
 * `summarize` 返回 `null`（生成失败 / 解析失败 / 空摘要）→ 退回抽取式行为（保留 notice 提示），
 * 保证摘要不可用时体验不比现在差。
 */
export async function compressHistoryWithSummary(
  messages: ChatMsg[],
  opts: CompressOptions & {
    summarize?: (dropped: ChatMsg[]) => Promise<string | null>;
  } = {},
): Promise<CompressResult> {
  const maxTokens = opts.maxTokens ?? DEFAULT_COMPRESSION_BUDGET;
  const minRecent = opts.minRecent ?? 4;
  const noticeText = opts.noticeText ?? DEFAULT_NOTICE_TEXT;
  const beforeTokens = estimateMessagesTokens(messages);

  const { systemMsgs, kept, dropped, compressed } = splitByBudget(messages, maxTokens, minRecent);

  if (!compressed) {
    return { messages: [...messages], compressed: false, droppedCount: 0, beforeTokens, afterTokens: beforeTokens };
  }

  // 尝试摘要：失败（抛错或返回 null/空）一律退回 notice 文本
  // 设计纪律：摘要失败是摘要器的问题，不该让压缩失败而阻断发送
  let summaryText: string | null = null;
  if (opts.summarize) {
    try {
      summaryText = await opts.summarize(dropped);
    } catch {
      summaryText = null;
    }
  }

  const noticeContent =
    summaryText !== null
      ? `[Earlier conversation summary (${dropped.length} messages compressed)]\n${summaryText}`
      : noticeText(dropped.length);

  return buildCompressedOutput(systemMsgs, kept, noticeContent, beforeTokens, dropped.length);
}
