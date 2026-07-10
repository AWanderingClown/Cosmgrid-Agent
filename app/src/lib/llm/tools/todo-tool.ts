// todo_write 工具（2026-07-05 新增）——对齐 gemini-cli(write-todos)/opencode(todo.ts)/
// Claude Code(TodoWrite)：让模型把多步骤任务的计划显式结构化，而不是只写在正文里。
//
// 全量替换语义（每次调用传完整列表，不是增量 diff）——跟三家参考实现一致，模型侧逻辑简单，
// 也避免"增量更新哪一项"的歧义。不需要用户确认（不改本地文件、无副作用），readOnly。
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - 空数组 → successResult("待办列表已清空")
// - 非空 → successResult + 列表内容
// 注：todo_write 本质就是 UI 渲染数据，没有错误路径；阶段2 也维持这一定位。

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { successResult, type ToolResultV2 } from "./result-contract";

const todoItemSchema = z.object({
  content: z.string().min(1).describe("这一项任务的内容"),
  status: z.enum(["pending", "in_progress", "completed"]).describe("当前状态"),
});

const paramsSchema = z.object({
  todos: z.array(todoItemSchema).describe("完整的待办列表（全量替换，不是增量追加）"),
});

type TodoWriteParams = z.infer<typeof paramsSchema>;

const STATUS_MARK: Record<string, string> = {
  completed: "[x]",
  in_progress: "[~]",
  pending: "[ ]",
};

export const todoWriteTool: ToolDefinition<TodoWriteParams> = {
  name: "todo_write",
  description:
    "维护当前任务的结构化待办清单，帮助你规划多步骤工作、让用户看到真实进度。每次调用传入完整列表（全量替换，不是增量追加）。" +
    "只在任务有 3 步以上时使用；简单任务不需要。开始做一步前把它标记 in_progress，做完立刻标记 completed——不要攒到最后一次性打勾，也不要谎报 completed。",
  parameters: paramsSchema,
  readOnly: true,
  security: { kind: "none" },
  async execute(input): Promise<ToolResultV2> {
    const totalCount = input.todos.length;
    const completedCount = input.todos.filter((t) => t.status === "completed").length;
    const inProgressCount = input.todos.filter((t) => t.status === "in_progress").length;

    if (totalCount === 0) {
      return successResult({
        output: "(待办列表已清空)",
        summary: "todo_write 清空",
        nextActions: [
          { action: "consider_more_breakdown", reason: "清空意味着这一轮任务结束", safe: true },
        ],
      });
    }

    const lines = input.todos.map((item) => `${STATUS_MARK[item.status]} ${item.content}`);
    return successResult({
      output: lines.join("\n"),
      summary: `todo_write ${completedCount}/${totalCount} 完成（${inProgressCount} 进行中）`,
      nextActions:
        inProgressCount === 0 && completedCount < totalCount
          ? [
              {
                action: "start_next_pending",
                reason: `还有 ${totalCount - completedCount} 项 pending，挑下一项开始（标记 in_progress）`,
                safe: true,
              },
            ]
          : [],
    });
  },
};