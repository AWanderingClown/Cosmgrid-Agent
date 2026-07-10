// v0.7 阶段4b — bash 工具（US-4.5：跑 pnpm test 等白名单命令）
//
// 产品最危险的入口，三道闸全开：
//   1. command-safety 白名单 + 危险拦截（block 直接拒）
//   2. 必须 ctx.confirm 用户确认（没有确认通道=拒绝）
//   3. 在 workspace 目录里执行；输出截断回传

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { isReadOnlyCommand } from "./command-safety";
import { getShellAdapter } from "./shell-adapter";
import { requireApproval } from "./confirm";

const paramsSchema = z.object({
  command: z.string().describe("要执行的 shell 命令，如 pnpm test"),
});

type BashParams = z.infer<typeof paramsSchema>;

/** stdout/stderr 各自截断上限 */
const BASH_OUTPUT_LIMIT = 5000;

function clip(s: string): string {
  return s.length > BASH_OUTPUT_LIMIT ? s.slice(0, BASH_OUTPUT_LIMIT) + "\n…(截断)" : s;
}

export const bashTool: ToolDefinition<BashParams> = {
  name: "bash",
  description: "在工作文件夹根目录执行一条 shell 命令（如 pnpm test / git status）。命令已经在工作目录里运行，直接用相对路径，不要用 cd 切目录。搜文件内容优先用 grep 工具、找文件用 glob 工具、读文件用 read 工具（更可靠）；bash 主要用于跑测试 / 构建 / git 等。危险命令会被拦截，写操作需用户确认。",
  parameters: paramsSchema,
  readOnly: false,
  security: { kind: "command", commandField: "command" },
  async execute(input, ctx): Promise<ToolResult> {
    // 闸 1：安全分类，现在由 executor 按 tool.security 声明强制跑（L6 安全网收拢，2026-07-09）——
    // 走到这里说明 checkCommand 已经判过 allow，block 在 executor 层就直接 denied 了。

    // 闸 2：只读命令（git log/status/diff、ls/cat/grep 等只看不改）免确认，看项目不被打扰；
    //        写/有副作用命令（装依赖、git 提交、跑脚本等）才需用户确认。
    if (!isReadOnlyCommand(input.command)) {
      const denied = await requireApproval(ctx, {
        toolName: "bash",
        summary: `在 ${ctx.workspacePath} 执行：${input.command}`,
      });
      if (denied) return denied;
    }

    // 闸 3：执行
    try {
      const res = await getShellAdapter().run(input.command, ctx.workspacePath);
      const ok = res.code === 0 || res.code === null;
      const body = [
        `$ ${input.command}`,
        clip(res.stdout).trimEnd(),
        res.stderr.trim() ? `--- stderr ---\n${clip(res.stderr).trimEnd()}` : "",
        `exit code: ${res.code ?? "?"}`,
      ].filter(Boolean).join("\n");
      return { status: ok ? "success" : "error", output: body };
    } catch (err) {
      return { status: "error", output: `执行失败：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
