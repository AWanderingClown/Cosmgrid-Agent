// v0.7 阶段4b — bash 工具（US-4.5：跑 pnpm test 等白名单命令）
//
// 产品最危险的入口，三道闸全开：
//   1. command-safety 白名单 + 危险拦截（block 直接拒）
//   2. 必须 ctx.confirm 用户确认（没有确认通道=拒绝）
//   3. 在 workspace 目录里执行；输出截断回传
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - 拒绝 / 安全拦截 → deniedResult{retryable=false, stopCondition:"等待用户授权或换非写命令"}
// - 退出码非 0 → errorResult{TOOL_COMMAND_FAILED, retryable 看 isReadOnlyCommand,
//   写命令 retryable=false，读命令 retryable=true（重跑一遍有时能复现失败原因）}
// - 成功 → successResult + command_output artifact + 可选 nextActions（如"运行测试"）。

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { isReadOnlyCommand } from "./command-safety";
import { getShellAdapter } from "./shell-adapter";
import { requireApprovalAsV2 } from "./confirm";
import {
  errorResult,
  successResult,
  TOOL_COMMAND_FAILED,
  type ToolArtifactRef,
  type ToolResultV2,
} from "./result-contract";

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
  async execute(input, ctx): Promise<ToolResultV2> {
    // 闸 1：安全分类，现在由 executor 按 tool.security 声明强制跑（L6 安全网收拢，2026-07-09）——
    // 走到这里说明 checkCommand 已经判过 allow，block 在 executor 层就直接 denied 了。

    // 闸 2：只读命令（git log/status/diff、ls/cat/grep 等只看不改）免确认，看项目不被打扰；
    //        写/有副作用命令（装依赖、git 提交、跑脚本等）才需用户确认。
    if (!isReadOnlyCommand(input.command)) {
      const denied = await requireApprovalAsV2(
        ctx,
        {
          toolName: "bash",
          summary: `在 ${ctx.workspacePath} 执行：${input.command}`,
        },
        "用户拒绝执行 bash",
      );
      if (denied) return denied;
    }

    // 闸 3：执行
    try {
      const res = await getShellAdapter().run(input.command, ctx.workspacePath);
      const ok = res.code === 0 || res.code === null;
      const stdout = clip(res.stdout).trimEnd();
      const stderr = res.stderr.trim() ? `--- stderr ---\n${clip(res.stderr).trimEnd()}` : "";
      const exitLine = `exit code: ${res.code ?? "?"}`;
      const body = [`$ ${input.command}`, stdout, stderr, exitLine].filter(Boolean).join("\n");

      const artifacts: ToolArtifactRef[] = [
        {
          kind: "command_output",
          uri: input.command,
          label: `${input.command} (exit ${res.code ?? "?"})`,
          exitCode: res.code ?? undefined,
        },
      ];

      if (ok) {
        return successResult({
          output: body,
          summary: `${input.command} → exit ${res.code ?? 0}`,
          artifacts,
          nextActions: res.code === 0
            ? [
                {
                  action: "verify_with_tests",
                  reason: "命令成功了；如果是 build/test 类命令，下一步建议跑相关测试验证",
                  safe: true,
                },
              ]
            : [],
        });
      }

      // 命令退出码非 0：errorResult，retryable 视命令语义——
      // 写命令（git commit / rm / pnpm install）失败不该自动重试（重试只会重现同样的失败）；
      // 读命令（git status / ls）失败可以重试一次（可能是临时状态）。
      const readOnly = isReadOnlyCommand(input.command);
      return errorResult({
        output: body,
        summary: `${input.command} 退出码 ${res.code}`,
        error: {
          code: TOOL_COMMAND_FAILED,
          rootCauseHint: stderr
            ? `命令退出码 ${res.code}，stderr 摘录：${stderr.slice(0, 200)}`
            : `命令退出码 ${res.code}`,
          retryable: readOnly,
          retryInstruction: readOnly
            ? "只读命令可以再试一次，失败原因可能跟文件状态/网络抖动有关"
            : "写命令失败不建议立即重试，先看 stderr 修复根本原因（权限 / 路径 / 资源）",
          stopCondition: readOnly
            ? undefined
            : "连续失败 2 次后停止重试，必须先看 stderr 修根因",
        },
        artifacts,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult({
        output: `执行失败：${msg}`,
        summary: `bash 抛错 ${input.command}`,
        error: {
          code: TOOL_COMMAND_FAILED,
          rootCauseHint: msg,
          retryable: false,
          stopCondition: "shell adapter 抛错通常是进程层失败（如超时/资源耗尽），先排查环境",
        },
      });
    }
  },
};