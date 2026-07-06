// 意图识别阶段3 自我成长闭环——"降权"这一半（此前只实现了"纠正后加权"）。
//
// 两条独立路径，跟 useChatStream.ts 里已有的 upsertExample(weight: 1.25) 加权逻辑对称：
// 1. 误判降权：本轮判断错了（用户明确纠正），导致这次误判的那条样例权重打折。
// 2. 长期不用衰减：样例长期没有被任何一次真实纠正/强化事件触碰过，权重逐步衰减，
//    避免陈旧或一次性误判的样例一直占着高权重继续误导后续判断。
//
// 设计取舍（同 orchestrator.ts 的 derivePhase 模式）：判断逻辑是纯函数、可单测；
// 真正读写数据库是薄封装，调用方（useChatStream.ts / App.tsx 启动流程）负责接线。

import { intentLearning, type StoredIntentExample } from "@/lib/db";
import {
  routeTurnIntentSemantically,
  type IntentExample,
  type IntentRouteAction,
} from "./semantic-intent-router";

/** 误判降权：单次误判对样例权重的打折系数 */
export const MISJUDGE_DOWNWEIGHT_FACTOR = 0.7;
/** 长期不用衰减：单次衰减打折系数 */
export const DECAY_FACTOR = 0.85;
/** 权重跌破这个阈值就直接禁用样例，而不是继续留着一个几乎不起作用的低权重样例 */
export const MIN_WEIGHT_BEFORE_DISABLE = 0.4;
/** 超过这么多天没有被强化过（没有任何纠正事件命中过）就判定为"长期不用" */
export const DECAY_THRESHOLD_DAYS = 30;

export interface WeightAdjustment {
  id: string;
  action: IntentRouteAction;
  previousWeight: number;
  nextWeight: number;
  disabled: boolean;
}

/**
 * 误判降权（纯函数）：给定"这一轮被判定错误的 action"和当时参与路由的全部样例，
 * 找出真正"投票"给这个错误 action 的那条样例，算出它降权后的新权重。
 *
 * 只对非内置样例生效——BUILTIN_INTENT_EXAMPLES 是运行时常量，不落库，改不了权重；
 * 这是已知的范围边界，不是遗漏（内置样例本身就该是稳定基线，用户纠正应该体现在
 * "新增/降权用户自己的样例"上，而不是悄悄改动内置基线）。
 */
export function findMisjudgedExampleToDownweight(
  text: string,
  predictedAction: IntentRouteAction,
  examples: IntentExample[],
): WeightAdjustment | null {
  const route = routeTurnIntentSemantically(text, examples);
  const candidate = route.candidates.find((c) => c.action === predictedAction);
  if (!candidate) return null;
  const matched = candidate.matchedExample;
  if (matched.source === "builtin") return null;

  const nextWeight = matched.weight * MISJUDGE_DOWNWEIGHT_FACTOR;
  const disabled = nextWeight < MIN_WEIGHT_BEFORE_DISABLE;
  return {
    id: matched.id,
    action: matched.action,
    previousWeight: matched.weight,
    nextWeight,
    disabled,
  };
}

/** 长期不用衰减（纯函数）：给定当前全部启用样例 + 当前时间，算出哪些该衰减、哪些该禁用 */
export function computeDecayPlan(
  examples: StoredIntentExample[],
  now: Date,
): WeightAdjustment[] {
  const out: WeightAdjustment[] = [];
  for (const example of examples) {
    if (example.source === "builtin") continue; // 内置样例不落库，不参与衰减
    const updatedAt = new Date(example.updatedAt);
    const ageDays = (now.getTime() - updatedAt.getTime()) / 86_400_000;
    if (!(ageDays >= DECAY_THRESHOLD_DAYS)) continue;
    const nextWeight = example.weight * DECAY_FACTOR;
    out.push({
      id: example.id,
      action: example.action,
      previousWeight: example.weight,
      nextWeight,
      disabled: nextWeight < MIN_WEIGHT_BEFORE_DISABLE,
    });
  }
  return out;
}

async function applyWeightAdjustment(adj: WeightAdjustment): Promise<void> {
  if (adj.disabled) {
    await intentLearning.setExampleEnabled(adj.id, false);
  } else {
    await intentLearning.updateExampleWeight(adj.id, adj.nextWeight);
  }
}

/** 薄封装：真的从库里读样例、算出误判降权的目标、写回库。调用方在检测到用户纠正时调用。 */
export async function downweightMisjudgedExampleInDb(
  text: string,
  predictedAction: IntentRouteAction,
  examples: IntentExample[],
): Promise<WeightAdjustment | null> {
  const adjustment = findMisjudgedExampleToDownweight(text, predictedAction, examples);
  if (!adjustment) return null;
  await applyWeightAdjustment(adjustment);
  return adjustment;
}

/** 薄封装：真的从库里读全部启用样例，算出长期不用衰减计划，逐条写回库。
 *  建议在应用启动时调用一次（跟 syncModelPrices/backfillProjectMemoryVectors 同级别的后台任务）。 */
export async function decayStaleIntentExamples(now: Date = new Date()): Promise<WeightAdjustment[]> {
  const examples = await intentLearning.listExamples({ enabledOnly: true });
  const plan = computeDecayPlan(examples, now);
  for (const adj of plan) {
    await applyWeightAdjustment(adj);
  }
  return plan;
}
