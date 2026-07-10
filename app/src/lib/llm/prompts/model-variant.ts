// 2026-07-10 OMO-5 —— 移植 OMO prompts-core/variant-resolver.ts 的思路：
// 按模型名判断"模型族"，用于挑选该模型该用的 prompt 变体。
//
// 目前唯一的分类维度是"是否国产模型"（对应 context-preamble.ts 的
// buildDomesticModelReminder——国产模型需要额外反编造提醒，见该文件内的
// opencode 源码调研注释）。这里做成通用分类器而不是私有判断函数，是因为
// 以后如果要再加别的"按模型族给不同话术"的 prompt（比如 GLM/Kimi 各自的
// 微调），可以直接复用同一份分类结果，不用每处各自维护一份关键词表——
// 单一信源，不是照抄 OMO 的 gpt/gemini/glm/kimi/minimax/opus-4-7 八路
// variant 全集（我们目前只有"国产/非国产"这一种真实需求，没有其余七种
// 的具体 prompt 差异，硬造出来是无依据的假设性分支）。

export type ModelVariant = "domestic" | "default";

// 查 opencode 源码（技术参考/opencode-dev/packages/opencode/src/session/system.ts:25）
// 发现它按 model.api.id 分了 8 套系统提示，只有 kimi.txt 一份里明确写了
// "Try your best to avoid any hallucination. Do fact checking..."——其余 7 份
// （含 anthropic/gpt/gemini）都没有这句，说明连成熟的多模型 harness 也认为
// 国产模型需要更直白的反编造提醒。
const DOMESTIC_MODEL_KEYWORDS = ["minimax", "kimi", "moonshot", "glm", "智谱", "qwen", "通义", "deepseek"];

/** 按驱动模型的人类可读名（如 "MiniMax-M3"）判断该用哪套 prompt 变体。 */
export function resolveModelVariant(driverLabel: string | null | undefined): ModelVariant {
  if (!driverLabel) return "default";
  const lower = driverLabel.toLowerCase();
  return DOMESTIC_MODEL_KEYWORDS.some((kw) => lower.includes(kw)) ? "domestic" : "default";
}
