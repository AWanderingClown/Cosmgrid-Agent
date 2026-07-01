import type { TurnAction, TurnIntentDecision } from "@/lib/workflow/types";

const WORKFLOW_INTENT_RE =
  /(改|修改|修|修复|写|实现|创建|新增|删除|重构|运行|执行|测试|检查|构建|打包|编译|报错|排查|代码|文件|项目|组件|页面|接口|数据库|build|test|lint|typecheck|fix|implement|create|delete|refactor|run|debug|bug)/i;
const PLAN_ONLY_INTENT_RE =
  /(方案|计划|规划|路线图|架构|设计|评审方案|完善计划|建议|优先级|排期|看一下.*对不对|review.*plan|plan|roadmap|architecture|proposal)/i;
const EXECUTION_INTENT_RE =
  /(开始做|开始实现|直接实现|落地|改代码|修复|创建文件|新增|删除|重构|运行|执行|测试|构建|打包|编译|build|test|lint|typecheck|fix|implement|create|delete|refactor|run|debug)/i;

export function hasWorkflowIntent(text: string): boolean {
  return WORKFLOW_INTENT_RE.test(text.trim());
}

export function shouldRunBackgroundOrchestration(args: {
  text: string;
  taskRole: string;
  hasWorkspace: boolean;
  /**
   * 语义意图判断的结论（classifyTurnIntentWithJudge 产出）。
   * "聊idea/纯讨论" vs "已经收敛成要执行的具体任务" 是语义判断的活，
   * 关键词命中 hard 不能替代它——否则"为什么这样设计"这类纯讨论也会被当成任务，
   * 在没绑工作文件夹时把用户手选的模型静默换掉。
   */
  intentAction: TurnAction;
}): boolean {
  if (args.intentAction === "answer_only") return false;
  if (args.hasWorkspace) return args.taskRole === "hard" || hasWorkflowIntent(args.text);
  // 无工作文件夹：语义判断已认定这不是纯讨论（比如想法已经收敛成具体方案，
  // 判出 start_run/continue_run 等动作），才允许后台编排介入、自动切模型。
  return true;
}

export function shouldAutoRunChain(args: {
  text: string;
  chain: readonly string[];
  decision?: TurnIntentDecision | null;
}): boolean {
  if (args.chain.length === 0) return false;

  if (args.decision) {
    return args.decision.action === "approve_node"
      || args.decision.patch?.executionMode === "execute_directly"
      || args.decision.patch?.executionMode === "plan_then_execute";
  }

  const text = args.text.trim();
  const planOnly = PLAN_ONLY_INTENT_RE.test(text) && !EXECUTION_INTENT_RE.test(text);
  if (planOnly) return false;

  return true;
}
