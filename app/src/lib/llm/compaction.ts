// 阶段5 — 上下文压缩（抄 MAF _compaction.py 的 SlidingWindowStrategy）。
//
// 长会话 token 爆炸时，保留 system + 最近 N 条，老消息折叠成一行摘要。
// 现有 context-compressor 是抽取式（v0.9），本文件提供 sliding-window 补充工具，
// 待长会话痛点出现或评估后接入（TODO）。
//
// MAF 原子 group 约束：assistant(tool_calls) + tool_result 整组留或删——
// 简化版按消息边界切，不拆 group；完整 group 感知留 TODO（要项目消息格式带 group 标记）。

export interface CompactMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface CompactOptions {
  /** 保留最近几条非 system 消息（默认 6） */
  keepRecent?: number;
}

/**
 * 滑动窗口压缩：保留所有 system + 最近 N 条非 system，中间老的折叠成一行摘要。
 * 不足 keepRecent 条不动。
 */
export function slidingWindowCompact(
  messages: CompactMessage[],
  opts: CompactOptions = {},
): CompactMessage[] {
  const keepRecent = opts.keepRecent ?? 6;
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  if (rest.length <= keepRecent) return [...messages];

  const dropped = rest.length - keepRecent;
  const keep = rest.slice(-keepRecent);
  return [
    ...system,
    { role: "system", content: `[…已折叠 ${dropped} 条早期对话，省 token…]` },
    ...keep,
  ];
}
