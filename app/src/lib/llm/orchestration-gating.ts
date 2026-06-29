const WORKFLOW_INTENT_RE =
  /(改|修改|修|修复|写|实现|创建|新增|删除|重构|运行|执行|测试|检查|构建|打包|编译|报错|排查|代码|文件|项目|组件|页面|接口|数据库|build|test|lint|typecheck|fix|implement|create|delete|refactor|run|debug|bug)/i;

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
