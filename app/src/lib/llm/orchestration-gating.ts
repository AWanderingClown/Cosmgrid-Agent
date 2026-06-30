const WORKFLOW_INTENT_RE =
  /(改|修改|修|修复|写|实现|创建|新增|删除|重构|运行|执行|测试|检查|构建|打包|编译|报错|排查|代码|文件|项目|组件|页面|接口|数据库|build|test|lint|typecheck|fix|implement|create|delete|refactor|run|debug|bug)/i;
const PLAN_ONLY_INTENT_RE =
  /(方案|计划|规划|路线图|架构|设计|评审方案|完善计划|建议|plan|roadmap|architecture|proposal)/i;
const EXECUTION_INTENT_RE =
  /(开始做|开始实现|直接实现|落地|改代码|修复|创建文件|新增|删除|重构|运行|执行|测试|构建|打包|编译|build|test|lint|typecheck|fix|implement|create|delete|refactor|run|debug)/i;

export function hasWorkflowIntent(text: string): boolean {
  return WORKFLOW_INTENT_RE.test(text.trim());
}

export function shouldRunBackgroundOrchestration(args: {
  text: string;
  taskRole: string;
  hasWorkspace: boolean;
}): boolean {
  if (args.taskRole === "hard") return true;
  if (!args.hasWorkspace) return false;
  return hasWorkflowIntent(args.text);
}

export function shouldAutoRunChain(args: {
  text: string;
  chain: readonly string[];
}): boolean {
  if (args.chain.length === 0) return false;

  const text = args.text.trim();
  const planOnly = PLAN_ONLY_INTENT_RE.test(text) && !EXECUTION_INTENT_RE.test(text);
  if (planOnly && args.chain.every((role) => role === "architect")) {
    return false;
  }

  return true;
}
