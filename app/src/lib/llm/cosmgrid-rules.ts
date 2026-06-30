import cosmgridRules from "./CosmGrid.md?raw";

// CosmGrid 核心工作规则（“灵魂文件”）—— 产品给所有模型的统一系统提示。
//
// 一处定义，两路注入：
//   - API 模型：buildCorePreamble() 作为最前面的 system 消息（ChatPage outgoing）。
//   - CLI 引擎（claude/codex spawn）：COSMGRID_RULES 经 --append-system-prompt 注入
//     （因为 spawn 时 --setting-sources "" 屏蔽了本机 CLAUDE.md，必须我们显式塞）。
//
// 设计原则：系统提示本身就是给模型的“简洁”示范——所以这文件自己也保持精炼克制，
// 用短句和朴素结构，不堆装饰。措辞会直接影响所有模型的回复风格，改这里 = 改产品灵魂。

/** 纯规则正文（不含动态环境）。给 CLI --append-system-prompt 用。 */
export const COSMGRID_RULES = cosmgridRules.trim();

function detectOs(): string {
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    const ua = navigator.userAgent;
    if (/Mac/i.test(ua)) return "macOS";
    if (/Win/i.test(ua)) return "Windows";
    if (/Linux/i.test(ua)) return "Linux";
  }
  return "未知";
}

/**
 * 规则 + 动态环境，给 API 模型作为 system 消息。
 * @param workspacePath 当前工作文件夹（没绑则不带）
 */
export function buildCorePreamble(workspacePath?: string | null): string {
  const env: string[] = [`系统：${detectOs()}`];
  if (workspacePath) env.push(`当前工作目录：${workspacePath}`);
  return `${COSMGRID_RULES}\n\n## 环境\n${env.join("\n")}`;
}
