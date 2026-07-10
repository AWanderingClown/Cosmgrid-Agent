// 3.1 修复（2026-07-02）：AI 写入记忆工具
//
// 坑.md 3.1 现象：全项目搜索 `projectMemories.create` 的真实调用点，只有 MemoryDialogs.tsx
// 里的手动表单（用户自己填）。AI 自己没有任何写记忆的工具——`app/src/lib/llm/tools/` 目录
// 搜不到任何 memory 相关工具。库大概率是空的，讨论"embedding 准不准"没意义。
//
// 解决：给 AI 新增 remember 工具，让它在对话里自己判断"这轮产生了值得记的决策/教训/偏好"
// 就主动调用，参数化标题/内容/类型/重要性。走跟 write-tool 一样的 confirm 权限模型（不绕过
// 用户审批）。属于"自动档"——AI 不需要每次都问用户"要记吗"，根据 importance 自己定夺。
//
// 安全边界：
// 1. 必须有 ctx.confirm，否则 denied（绝不静默落库）
// 2. 用户在确认弹窗看到 title + content + kind，可以拒绝
// 3. importance < 20 的会被标"低优先级"，库查询时不主动召回（避免噪音）
// 4. 标题和内容长度上限防垃圾数据

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { requireApproval } from "./confirm";
import { projectMemories, type MemoryKind } from "@/lib/db/memory";
import { conversations } from "@/lib/db";

const paramsSchema = z.object({
  title: z.string().min(1).max(200).describe("记忆标题（一句话概述这条记忆在说什么）"),
  content: z.string().min(1).max(2000).describe("记忆详细内容（事实/决策/偏好/教训）"),
  kind: z
    .enum(["decision", "lesson", "context", "preference", "other"])
    .optional()
    .describe("记忆类型：decision=决策、lesson=教训、context=背景、preference=偏好、其他"),
  importance: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("重要性 0-100，>=60 会在后续 AI 对话中主动召回，<60 不会（默认 50，即默认不召回，重要的信息要显式给更高分）"),
  tags: z.array(z.string()).optional().describe("可选标签，方便后续按 tag 检索"),
});

type RememberParams = z.infer<typeof paramsSchema>;

/**
 * 通过 conversationId 查 projectId（memory 必须挂在某个 project 下，否则跨项目查不到）。
 * 没绑 project 就用 conversationId 当作 projectId 标识（凑合能存，跨项目召回时按时间排）。
 */
async function resolveProjectIdForMemory(
  conversationId: string | null,
): Promise<string | null> {
  if (!conversationId) return null;
  const conv = await conversations.getById(conversationId).catch(() => null);
  return conv?.projectId ?? null;
}

export const rememberTool: ToolDefinition<RememberParams> = {
  name: "remember",
  description:
    "把当前对话中产生的关键决策、教训、偏好或背景知识保存到项目记忆库。" +
    "后续对话会按重要性自动召回这些记忆，帮助你跨会话保持上下文连贯。" +
    "调用前先评估：这条信息用户是否会希望未来对话也知道？是 → 调本工具。" +
    "重要性 >= 60 会在后续 AI 对话中主动召回，< 60 不会（默认 50，不召回；确实重要就给 60 以上）。",
  parameters: paramsSchema,
  readOnly: false,
  security: { kind: "none" },

  async execute(input, ctx): Promise<ToolResult> {
    const kind: MemoryKind = input.kind ?? "other";
    const importance = input.importance ?? 50;

    // 安全：必须用户确认才能落库
    const denied = await requireApproval(ctx, {
      toolName: "remember",
      summary: `记忆：${input.title}`,
      // 给用户看到完整内容（决策/教训类内容用户要看清楚才敢确认）
      diff: `kind: ${kind}\nimportance: ${importance}\n\n${input.content}`,
    });
    if (denied) return denied;

    try {
      const projectId = await resolveProjectIdForMemory(ctx.conversationId ?? null);
      if (!projectId) {
        return {
          status: "error",
          output: "记忆失败：当前对话未绑定项目，记忆必须挂在具体项目下才能保存。",
        };
      }
      const memory = await projectMemories.create({
        projectId,
        kind,
        title: input.title,
        content: input.content,
        importance,
        tags: input.tags && input.tags.length > 0 ? input.tags.join(",") : null,
      });

      return {
        status: "success",
        output: `已记住：${memory.title}（${memory.kind}，重要性 ${memory.importance}/100）`,
      };
    } catch (err) {
      return {
        status: "error",
        output: `记忆失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};