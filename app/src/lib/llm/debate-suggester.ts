// 增强-3（2026-06-22）：ChatPage 自动建议对弈。
//
// 病根：classifyMessageComplexity 已能判 hard，但从没联动 —— 用户遇到开放式权衡问题
// 也想不起来用多模型对弈（痛点2 的功能藏起来了）。这里给一个比 HARD_MARKERS 更窄的判断：
// 只在"有多种方案 / 需要权衡取舍"的开放式问题上建议对弈（调试、翻译、改名这类有唯一正解
// 的任务不该触发，否则提示变噪音）。

/** 开放式权衡信号：这类问题没有唯一正解，多模型出方案/反驳/裁判才有价值（中英） */
const DEBATE_MARKERS = [
  "架构", "技术选型", "选型", "方案", "对比", "权衡", "利弊", "优劣",
  "哪个更好", "哪个好", "选哪个", "该用", "用哪个", "要不要", "值不值得",
  "怎么设计", "如何设计", "设计思路", "取舍", "划算",
  "architecture", "trade-off", "tradeoff", "pros and cons", "which is better",
  "should i use", "should we use", "compare", " versus ", " vs ", "better choice",
];

/** 太短的输入即便命中也不建议（避免"要不要"这种半句话误触发） */
const MIN_LEN_FOR_SUGGEST = 8;

/**
 * 是否建议把这条消息升级成多模型对弈。纯静态规则、无副作用，便于单测。
 * 命中"多方案权衡"标记 且 长度达标 → true。
 */
export function shouldSuggestDebate(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_LEN_FOR_SUGGEST) return false;
  const lower = trimmed.toLowerCase();
  return DEBATE_MARKERS.some((m) => lower.includes(m));
}
