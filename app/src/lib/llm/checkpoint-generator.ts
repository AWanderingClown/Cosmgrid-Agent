// AI 自动生成检查点草稿
// 检查点的 9 个字段（goal/completedSummary/.../acceptanceCriteria）原本要用户手填，
// 但检查点本质是"把已经发生的对话总结成交接备忘录"——这是 AI 该干的事，不该让用户重新打字复述一遍对话内容。
//
// 设计原则：
// 1. 只读对话历史，不调用任何写操作——生成的是草稿，用户在 UI 上还能改，不直接落库
// 2. 字段允许为空字符串（用 z.string()，不强制非空）：对话信息不足时，AI 应该留空而不是编造
// 3. 失败时直接抛错，不在这一层吞掉——调用方（UI）负责展示错误并允许用户退回手填

import { generateObject } from "ai";
import { z } from "zod";
import type { LanguageModel } from "./provider-factory";
import { resolveMaxOutputTokens } from "./model-limits";

export const checkpointDraftSchema = z.object({
  title: z.string().describe("检查点标题，简短概括这次交接的内容"),
  goal: z.string().describe("这个检查点要达成什么目标"),
  completedSummary: z.string().describe("到目前为止已经完成的工作总结"),
  currentContext: z.string().describe("下一个角色需要知道的关键背景信息"),
  decisions: z.string().describe("过程中做出的关键决策，以及为什么这么选、放弃了哪些方案"),
  failedAttempts: z.string().describe("尝试过但没有效果的方法（没有则留空）"),
  blockers: z.string().describe("当前卡住、阻塞的问题（没有则留空）"),
  nextSteps: z.string().describe("下一个角色具体需要做什么"),
  doNotRepeat: z.string().describe("已经验证过行不通、不要再重复尝试的事情（没有则留空）"),
  acceptanceCriteria: z.string().describe("怎么算这个检查点的工作「做完了」"),
});

export type CheckpointDraft = z.infer<typeof checkpointDraftSchema>;

export interface ConversationTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * 根据一段对话历史，生成检查点草稿。
 * 对话历史为空时也能调用，AI 会生成一份占位草稿（字段基本留空），由用户自行补充。
 */
export async function generateCheckpointDraft(
  languageModel: LanguageModel,
  history: ConversationTurn[],
): Promise<CheckpointDraft> {
  const transcript =
    history.length > 0
      ? history.map((m) => `[${m.role}] ${m.content}`).join("\n\n")
      : "（这段对话还没有任何内容）";

  const { object } = await generateObject({
    model: languageModel,
    schema: checkpointDraftSchema,
    // 按模型真实上限给足预算，避免推理型模型的结构化 JSON 被截断 → 解析失败
    maxOutputTokens: resolveMaxOutputTokens(languageModel.modelId),
    prompt: `你是一个项目交接助手。下面是某个工作阶段里 AI 和用户的完整对话记录，请基于这段对话生成一份"检查点"——
也就是把当前工作进展总结成一份交接备忘录，让下一个 AI/角色接手时能快速理解上下文，不用重新读完整对话。

要求：
- 只总结对话里**实际发生**的内容，不要编造没出现过的信息
- 对话里没体现的字段（比如没遇到阻塞，就 blockers 留空字符串）
- 语言简洁，每个字段几句话即可，不要逐句复述对话

对话记录：
${transcript}`,
  });

  return object;
}
