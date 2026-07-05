// Harness — 检测模型正文里「数字化的工具使用元叙述」（Ran 2 commands / 使用了5个工具 / 调用了3次），
// 但本轮真实 toolCallCount 对不上。
//
// 真实事故（2026-07-05）：模型在没有任何 OKX/链上工具的情况下，编出一整套"注册 ASP、加服务、
// 重新提交审核"的过程，正文里穿插"Ran 2 commands""Used 5 tools"这类看似日志的叙述。
// 这类编造不满足现有三类检测：
//   ① extract-claims 只认「文件路径」claim（这次编造的是业务状态，不是文件）
//   ② detect-pseudo-tools 只认字面的 XML/JSON 伪工具调用语法（这次是自然语言叙述，不是语法）
//   ③ detectIntentNoToolCall 只认「我先/让我」这类未来时意图语（这次是完成时态的既成事实叙述）
// 三个盲区的共同点：都没检查"数字"。而"数字化"反而是最强、最不容易误报的信号——
// 模型主动报出一个可核对的具体次数，只要这个数字超过本轮真实 toolCallCount，就一定是编的
// （真调用不会凭空多出来）。宁可漏报模糊表述（"我用了工具"不带数字），也不去猜。

const USAGE_COUNT_RE =
  /(?:Ran|Used|Executed|Called)\s+(\d+)\s+(?:commands?|tools?|tool\s*calls?)\b|(?:执行|调用|跑|使用|运行)了?\s*(\d+)\s*(?:个|条|次)?\s*(?:命令|工具)/gi;

/** 提取正文里所有「数字化工具/命令使用次数」的声称（可能有多处，取原始顺序） */
export function extractClaimedUsageCounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(USAGE_COUNT_RE)) {
    const raw = m[1] ?? m[2];
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/**
 * 判断是否存在「数字化工具使用叙述」与真实 toolCallCount 不符的编造。
 * 只要模型声称的最大次数 > 实际 toolCallCount 就判定编造；两者相等或声称更少则放行——
 * 避免误伤"我调用了 2 个工具，确实调了 2 个"这类正常复述。
 * @returns 编造的声称次数（用于纠正话术展示）；未编造或本文无此类声称则返回 null
 */
export function detectFabricatedUsageCount(text: string, actualToolCallCount: number): number | null {
  const counts = extractClaimedUsageCounts(text);
  if (counts.length === 0) return null;
  const maxClaimed = Math.max(...counts);
  return maxClaimed > actualToolCallCount ? maxClaimed : null;
}
