// ask_user_question 工具（2026-07-05 新增）——对齐 gemini-cli(ask-user)/opencode(question.ts)/
// Claude Code(AskUserQuestion)：任务中卡在只有用户知道答案的决策点时，结构化地停下来问，
// 而不是自己瞎猜、也不是把问题混在正文里指望用户注意到。
//
// 没有 ctx.askUser（当前环境不支持，比如没有对应 UI 通道）时直接 denied，明确告诉模型
// "别等了，直接给最佳判断"——不能让它以为问题已经问出去、傻等一个不会来的回答。

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";

const optionSchema = z.object({
  label: z.string().min(1).describe("选项的简短文本"),
  description: z.string().optional().describe("可选：这个选项意味着什么/权衡是什么"),
});

const paramsSchema = z.object({
  question: z.string().min(1).describe("要问用户的问题，清楚说明你卡在哪个决策点"),
  options: z.array(optionSchema).min(2).max(4).describe("2-4 个互斥的候选选项"),
});

type AskUserParams = z.infer<typeof paramsSchema>;

export const askUserTool: ToolDefinition<AskUserParams> = {
  name: "ask_user_question",
  description:
    "当任务存在只有用户能拍板、你自己判断不了的关键决策点时，暂停并向用户提问，给出 2-4 个互斥选项。" +
    "用户选择后你会收到选中项的 label 文本。只在真正卡住的决策点用，不要用来问琐碎问题或替代正常对话。",
  parameters: paramsSchema,
  readOnly: true,
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.askUser) {
      return {
        status: "denied",
        output: "当前环境不支持向用户提问（没有可用的追问通道）。请基于已知信息直接给出你的最佳判断，不要停下等待不会到来的回答。",
      };
    }
    const answer = await ctx.askUser({ question: input.question, options: input.options });
    return { status: "success", output: `用户选择：${answer}` };
  },
};
