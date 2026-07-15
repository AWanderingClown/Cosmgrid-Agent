import type { NextAction } from "@/lib/workflow/types";

/**
 * Task #9 独立复检发现的 HIGH 问题：debate 阶段有一条独立的执行入口 `runDebateRuntime`
 * （debate-runtime.ts），只由 `shouldRunDebateTurn` 检查"当前这条消息文本"里有没有博弈
 * 关键词来触发，跟 `workflowSnapshot.currentNodeId` 完全解耦。如果点击"开启多模型博弈"
 * 按钮时像其余四个 nextAction 一样走确定性推进（reducer 直接把 currentNodeId 挪到 debate
 * 节点），并不会真的启动博弈——用户点完按钮后如果下一句只说"继续"，博弈根本不会发生，
 * 静默走回单模型问答，跟 Task #9 本来要修的"分类器猜错就走错分支"是同一类症状。
 *
 * debate 这一个 action 必须走跟手打字完全一样的 handleSend 管线（intent classifier →
 * applyTurnIntentDecision 推进阶段 → shouldRunDebateTurn 判定为真 → runDebateRuntime
 * 真正执行）。其余四个 next action（make_plan/review_plan/execute_plan/verify_changes）
 * 没有独立 runtime，只是挪阶段指针给下一轮正常对话的工具能力门控用，确定性推进对它们是
 * 安全、正确的。
 */
export function shouldRouteNextActionAsChatMessage(
  action: Pick<NextAction, "targetPhase">,
): boolean {
  return action.targetPhase === "debate";
}
