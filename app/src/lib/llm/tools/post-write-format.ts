// L6 安全网收拢方案（2026-07-09）第四节 — 写后自动格式化
//
// AI 写/改文件成功后自动格式化，减少"AI 写出来的代码缩进/引号风格跟项目不一致"的摩擦。
// best-effort：格式化工具没装/报错都静默吞掉，不能让格式化失败影响写操作本身已经成功的结果。
//
// 2026-07-10 安全修复：原来用 `npx prettier --write "${absPath}"` 字符串拼接走 `sh -c`，
// 文件名里含 `;` / `&&` / `|` 等元字符会被 shell 解释成第二条命令。改成参数数组由
// `shellAdapter.runArgs` 走（Rust 端 `run_shell_args`，不经 sh），每个文件名都是独立
// 的 argv 元素，shell 没法把它当成新命令的开始。

import { getShellAdapter } from "./shell-adapter";

const FORMATTABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".css",
  ".md",
]);

function extensionOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx).toLowerCase();
}

/**
 * AI 写/改文件成功后自动格式化。absPath 必须是 executor 已经跑过 path-safety 解析后的
 * 绝对路径，不要在这里重新解析。失败（格式化工具没装 / 文件语法错误解析不了）静默吞掉，
 * 调用方不 await 这个返回值影响写操作本身的成功结果。
 */
export async function runPostWriteFormatter(absPath: string): Promise<void> {
  const ext = extensionOf(absPath);
  let args: string[] | null = null;
  if (FORMATTABLE_EXTENSIONS.has(ext)) {
    args = ["npx", "prettier", "--write", absPath];
  } else if (ext === ".rs") {
    args = ["rustfmt", absPath];
  }
  if (!args) return;
  try {
    await getShellAdapter().runArgs(args, ".");
  } catch {
    // 格式化失败不影响写操作本身已经成功
  }
}
