import type { TurnIntentDecision } from "@/lib/workflow/types";

const WRITE_OR_EXECUTE_RE =
  /(改代码|修改代码|修复|实现|落地|新建文件|创建文件|写入文件|保存到|导出到|编辑文件|运行命令|执行命令|跑测试|运行测试|跑构建|构建|编译|安装依赖|npm install|pnpm install|yarn install|build|test|typecheck|lint)/i;

const ARTICLE_WRITING_RE = /(软文|公众号|推广文|文章|文案|帖子|推文|营销文案|宣传文案)/i;

/**
 * V2 修复（2026-07-02）：判断这轮消息本身"是不是想干写类的活"，不考虑权限档位。
 * 从 shouldExposeWriteTools 里拆出来，供 ChatPage 在"没给写工具"时区分两种情况：
 * ①消息本来就不需要写（正常，什么都不用提示）②消息明明想写，但权限档/没绑文件夹把它挡住了
 * （这种要显式告诉用户，不能让 AI 自己装傻或被 harness 抓到"编了工具调用"）。
 */
export function impliesWriteIntent(args: { text: string; decision: TurnIntentDecision }): boolean {
  const text = args.text.trim();
  if (ARTICLE_WRITING_RE.test(text) && !WRITE_OR_EXECUTE_RE.test(text)) return false;

  if (WRITE_OR_EXECUTE_RE.test(text)) return true;
  if (args.decision.action === "approve_node") return true;
  if (args.decision.patch?.executionMode === "execute_directly") return true;
  if (args.decision.patch?.verificationRequired) return true;

  return false;
}

export function shouldExposeWriteTools(args: {
  text: string;
  permissionMode: "read" | "confirm" | "auto";
  decision: TurnIntentDecision;
}): boolean {
  if (args.permissionMode === "read") return false;
  return impliesWriteIntent(args);
}
