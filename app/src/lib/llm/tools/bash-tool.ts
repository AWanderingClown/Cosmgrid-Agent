// v0.7 阶段4b — bash 工具（US-4.5：跑 pnpm test 等白名单命令）
//
// 产品最危险的入口，三道闸全开：
//   1. command-safety 白名单 + 危险拦截（block 直接拒）
//   2. 必须 ctx.confirm 用户确认（没有确认通道=拒绝）
//   3. 在 workspace 目录里执行；输出截断回传

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { checkCommand } from "./command-safety";
import { getShellAdapter } from "./shell-adapter";
import { requireApproval } from "./confirm";

const paramsSchema = z.object({
  command: z.string().describe("要执行的 shell 命令，如 pnpm test"),
});

type BashParams = z.infer<typeof paramsSchema>;

/** stdout/stderr 各自截断上限 */
export const BASH_OUTPUT_LIMIT = 5000;

function clip(s: string): string {
  return s.length > BASH_OUTPUT_LIMIT ? s.slice(0, BASH_OUTPUT_LIMIT) + "\n…(截断)" : s;
}

export const bashTool: ToolDefinition<BashParams> = {
  name: "bash",
  description: "执行一条白名单内的 shell 命令（如 pnpm test / git status）。危险命令会被拦截，执行前需用户确认。",
  parameters: paramsSchema,
  readOnly: false,
  async execute(input, ctx): Promise<ToolResult> {
    // 闸 1：安全分类
    const check = checkCommand(input.command, ctx.blockedCommands ?? []);
    if (check.verdict === "block") {
      return { status: "denied", output: `已拦截：${check.reason}` };
    }

    // 闸 2：用户确认（无确认通道=拒绝）
    const denied = await requireApproval(ctx, {
      toolName: "bash",
      summary: `在 ${ctx.workspacePath} 执行：${input.command}`,
    });
    if (denied) return denied;

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
