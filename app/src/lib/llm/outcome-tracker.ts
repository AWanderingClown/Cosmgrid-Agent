// 改进-1 Step B（2026-06-22）：隐式反馈信号编排。
//
// 病根：SmartRouter 评分只看"API 成没成 / 贵不贵 / 快不快"，不知道用户满不满意。但用户的小动作
// 早就暴露了态度——重答一遍、把便宜模型换回贵的、撤销 AI 的改动，都在说"刚才那次不行"。
// 这里把这些隐式动作转成一条质量样本喂回评分，让管家越用越懂你（痛点3 从"能跑"到"好用"的关键）。
//
// 定位策略：采集点不必持有 UsageEvent id，只要知道"哪个模型刚答得不满意"，
// 由 usageEvents.setOutcomeForLatest 找该模型最近一条未评价的回答打标（见 db.ts）。

import { usageEvents } from "../db";
import { recordOutcomeSignal } from "./model-performance-stats";

/** 隐式反馈信号类型 */
export type OutcomeSignal = "accepted" | "retried" | "switched_up" | "reverted" | "rejected";

/** 只有"用户接受了"是正反馈；其余（重答/切回贵模型/回滚/拒绝）都是负反馈 */
export function isPositiveOutcome(outcome: OutcomeSignal): boolean {
  return outcome === "accepted";
}

/**
 * 记录一条隐式反馈：给该模型最近一条未评价回答打 outcome 标签，并把正/负反馈喂回评分统计。
 * 旁路操作，任何失败只记日志不抛（不能拖垮主对话流）。
 */
export async function applyOutcomeForLatest(
  modelId: string,
  outcome: OutcomeSignal,
): Promise<void> {
  try {
    const res = await usageEvents.setOutcomeForLatest(modelId, outcome);
    if (!res || !res.taskType) return;
    await recordOutcomeSignal(modelId, res.taskType, isPositiveOutcome(outcome));
  } catch (error) {
    console.error("[outcome-tracker] 应用反馈信号失败:", error);
  }
}
