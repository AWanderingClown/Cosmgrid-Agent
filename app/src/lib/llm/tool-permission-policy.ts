import type { TurnIntentDecision } from "@/lib/workflow/types";

const WRITE_OR_EXECUTE_RE =
  /(改代码|修改代码|修复|实现|落地|新建文件|创建文件|写入文件|保存到|导出到|编辑文件|运行命令|执行命令|跑测试|运行测试|跑构建|构建|编译|安装依赖|npm install|pnpm install|yarn install|build|test|typecheck|lint)/i;

const ARTICLE_WRITING_RE = /(软文|公众号|推广文|文章|文案|帖子|推文|营销文案|宣传文案)/i;

export function shouldExposeWriteTools(args: {
  text: string;
  permissionMode: "read" | "confirm" | "auto";
  decision: TurnIntentDecision;
}): boolean {
  if (args.permissionMode === "read") return false;

  const text = args.text.trim();
  if (ARTICLE_WRITING_RE.test(text) && !WRITE_OR_EXECUTE_RE.test(text)) return false;

  if (WRITE_OR_EXECUTE_RE.test(text)) return true;
  if (args.decision.action === "approve_node") return true;
  if (args.decision.patch?.executionMode === "execute_directly") return true;
  if (args.decision.patch?.verificationRequired) return true;

  return false;
}
