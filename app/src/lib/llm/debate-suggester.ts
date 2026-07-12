// 增强-3（2026-06-22）：ChatPage 自动建议对弈。
//
// 病根：classifyMessageComplexity 已能判 hard，但从没联动 —— 用户遇到开放式权衡问题
// 也想不起来用多模型对弈（痛点2 的功能藏起来了）。这里给一个比 HARD_MARKERS 更窄的判断：
// 只在"有多种方案 / 需要权衡取舍"的开放式问题上建议对弈（调试、翻译、改名这类有唯一正解
// 的任务不该触发，否则提示变噪音）。
//
// 引擎化阶段 3：marker 列表搬到 lib/policy/debate-markers.ts，通过 getDebateMarkers() 读当前
// 生效值——默认 builtin，hydrateDebateMarkers() 启动预热后含 distribution override（运营侧可调）。

import { getDebateMarkers } from "@/lib/policy/debate-markers";

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
  for (const m of getDebateMarkers()) {
    if (lower.includes(m)) return true;
  }
  return false;
}

