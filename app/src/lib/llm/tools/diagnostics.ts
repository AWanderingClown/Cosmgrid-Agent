// 增强-1（2026-06-22）：写操作后自动类型检查（轻量 LSP 替代）。
//
// 病根：AI 改完代码看不到自己写错了——对看不懂代码、全靠"AI 自测自报"的 vibe coder 是致命缺口。
// OpenCode 有 LSP，我们没有。这里做轻量版：write/edit 写盘成功后自动跑 `tsc --noEmit`，
// 把"这个文件改完后有哪几处类型错误"附到工具返回里。AI 在多步 agentic 循环中看到错误，会继续自己修。
//
// 设计取舍：不接 typescript-language-server 长驻 stdio（重，要写 Rust 双向通信），而是复用已有
// run_shell_command 跑一次性 tsc。够 80% 价值、20% 成本。诊断是增值，任何失败都静默跳过，绝不拖垮写盘。

import { getShellAdapter, type ShellAdapter } from "./shell-adapter";
import { getFsAdapter } from "./fs-adapter";

/** 适用类型检查的文件扩展名（TS 家族）；其余文件跳过 */
const CHECKABLE_EXT = [".ts", ".tsx", ".mts", ".cts"];

export interface DiagnosticsDeps {
  shell: ShellAdapter;
  /** 判断工作区是否有 tsconfig.json（没有就不是 TS 项目，跳过检查） */
  hasTsconfig: (workspacePath: string) => Promise<boolean>;
}

function defaultDeps(): DiagnosticsDeps {
  return {
    shell: getShellAdapter(),
    hasTsconfig: (ws) => getFsAdapter().exists(`${ws}/tsconfig.json`),
  };
}

function isCheckable(absFilePath: string): boolean {
  const lower = absFilePath.toLowerCase();
  return CHECKABLE_EXT.some((ext) => lower.endsWith(ext));
}

/** 把绝对路径转成相对工作区的路径（用于匹配 tsc 输出里的文件名） */
export function toRelPath(workspacePath: string, absFilePath: string): string {
  const prefix = workspacePath.endsWith("/") ? workspacePath : `${workspacePath}/`;
  return absFilePath.startsWith(prefix) ? absFilePath.slice(prefix.length) : absFilePath;
}

/**
 * 纯函数：从 tsc --noEmit 的输出里挑出属于目标文件的错误行。
 * tsc 行格式：`src/foo.ts(12,5): error TS2345: ...`。宽松匹配（含相对路径 + "error TS"）。
 */
export function parseTscErrors(tscOutput: string, relPath: string): string[] {
  if (!relPath) return [];
  return tscOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.includes("error TS") && l.includes(relPath));
}

/** 把错误行拼成给 AI 看的诊断文本（中文，带修复指引） */
export function formatDiagnostics(relPath: string, errors: string[]): string {
  if (errors.length === 0) {
    return `✓ 自动类型检查：${relPath} 无类型错误。`;
  }
  return [
    `⚠️ 自动类型检查：${relPath} 改完后有 ${errors.length} 处类型错误，请继续修复后再交付：`,
    ...errors.map((e) => `  - ${e}`),
  ].join("\n");
}

/**
 * 跑一次类型检查，返回要附给 AI 的诊断文本；不适用（非 TS 文件 / 无 tsconfig / 出错）返回 null。
 * 永不抛——诊断是增值，失败就当没这功能。
 */
export async function runDiagnostics(
  workspacePath: string,
  absFilePath: string,
  deps: DiagnosticsDeps = defaultDeps(),
): Promise<string | null> {
  try {
    if (!isCheckable(absFilePath)) return null;
    if (!(await deps.hasTsconfig(workspacePath))) return null;

    const res = await deps.shell.run("npx --no-install tsc --noEmit", workspacePath);
    // tsc 把错误写到 stdout；合并 stderr 兜底
    const output = `${res.stdout}\n${res.stderr}`;
    const relPath = toRelPath(workspacePath, absFilePath);
    const errors = parseTscErrors(output, relPath);
    return formatDiagnostics(relPath, errors);
  } catch {
    return null;
  }
}

/** 便捷封装：把诊断结果追加到工具的成功 output 后面（无诊断则原样返回） */
export async function withDiagnostics(
  workspacePath: string,
  absFilePath: string,
  baseOutput: string,
  deps?: DiagnosticsDeps,
): Promise<string> {
  const diag = await runDiagnostics(workspacePath, absFilePath, deps);
  return diag ? `${baseOutput}\n\n${diag}` : baseOutput;
}
