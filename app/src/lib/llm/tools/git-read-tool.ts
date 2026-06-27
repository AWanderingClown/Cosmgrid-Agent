// v0.7 增强-2 — git 只读工具（AI 改完代码后能看到自己改了啥）
//
// 现状 git-snapshot 只写不读，AI commit 完看不到自己的改动。本工具补上只读侧：
//   status（工作区状态）/ diff（改动详情）/ log（提交历史）。
//
// 安全模型（与 bash 工具不同，这是只读工具，无需用户确认）：
//   1. 子命令限定白名单 status/diff/log——模型只能选 operation，不能传裸 git 参数
//   2. 参数由本工具构造成独立数组，经 Rust 不走 sh -c → 杜绝 shell 注入
//   3. 可选 path 经 path-safety 校验，越出工作区/命中敏感路径直接拒
// 因此模型无法借此跑 git push / reset --hard 等写命令。

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./types";
import { checkPath } from "./path-safety";
import { getGitReadAdapter } from "./git-read-adapter";

/** log 默认条数上限（避免历史过长撑爆上下文） */
const GIT_LOG_DEFAULT_COUNT = 20;
const GIT_LOG_MAX_COUNT = 100;
/** 输出截断上限（diff 可能很长） */
export const GIT_READ_OUTPUT_LIMIT = 8000;

const paramsSchema = z.object({
  operation: z
    .enum(["status", "diff", "log"])
    .describe("要执行的只读 git 操作：status=工作区状态，diff=改动详情，log=提交历史"),
  path: z
    .string()
    .optional()
    .describe("可选：只看某个文件/目录（相对工作区或绝对路径，须在工作区内）"),
  staged: z
    .boolean()
    .optional()
    .describe("仅 diff 有效：true 看已暂存改动（git diff --staged）"),
  maxCount: z
    .number()
    .int()
    .min(1)
    .max(GIT_LOG_MAX_COUNT)
    .optional()
    .describe(`仅 log 有效：最多显示几条提交（默认 ${GIT_LOG_DEFAULT_COUNT}）`),
});

type GitReadParams = z.infer<typeof paramsSchema>;

function clip(s: string): string {
  return s.length > GIT_READ_OUTPUT_LIMIT
    ? s.slice(0, GIT_READ_OUTPUT_LIMIT) + "\n…(截断)"
    : s;
}

/** 按 operation 构造白名单内的 git 参数数组。pathspec 一律放在 `--` 之后。 */
function buildGitArgs(input: GitReadParams, pathspec: string | null): string[] {
  const tail = pathspec ? ["--", pathspec] : [];
  switch (input.operation) {
    case "status":
      return ["status", "--short", "--branch", ...tail];
    case "diff":
      return ["diff", ...(input.staged ? ["--staged"] : []), ...tail];
    case "log": {
      const n = input.maxCount ?? GIT_LOG_DEFAULT_COUNT;
      return ["log", "--oneline", "-n", String(n), ...tail];
    }
  }
}

export const gitReadTool: ToolDefinition<GitReadParams> = {
  name: "git_read",
  description:
    "只读查看 git 状态：status（工作区改了哪些文件）、diff（具体改了什么）、log（最近提交）。仅查看，不会改动仓库。",
  parameters: paramsSchema,
  readOnly: true,
  async execute(input, ctx): Promise<ToolResult> {
    // 可选 path 做边界校验，越界/敏感直接拒
    let pathspec: string | null = null;
    const trimmedPath = input.path?.trim();
    if (trimmedPath) {
      const check = checkPath(ctx.workspacePath, trimmedPath);
      if (!check.ok) {
        return { status: "denied", output: check.reason ?? "路径不允许" };
      }
      pathspec = check.resolved;
    }

    const args = buildGitArgs(input, pathspec);

    try {
      const res = await getGitReadAdapter().run(ctx.workspacePath, args);
      // git 非零退出（多为「不是 git 仓库」），把 stderr 当错误回给模型
      if (res.code !== 0 && res.code !== null) {
        const msg = res.stderr.trim() || res.stdout.trim() || `git 退出码 ${res.code}`;
        return { status: "error", output: `git ${input.operation} 失败：${msg}` };
      }
      const body = res.stdout.trim() || "(无输出：工作区干净或无匹配)";
      return { status: "success", output: clip(body) };
    } catch (err) {
      return {
        status: "error",
        output: `执行 git ${input.operation} 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
