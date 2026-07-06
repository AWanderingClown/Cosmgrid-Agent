import type { IntentRouteAction } from "./semantic-intent-router";

export interface IntentCorrection {
  predictedAction: IntentRouteAction;
  correctedAction: IntentRouteAction;
  confidence: number;
}

const ACTION_LABELS: Record<IntentRouteAction, string> = {
  answer_only: "普通对话",
  start_run: "开始任务",
  continue_run: "继续任务",
  plan: "方案计划",
  review: "评审",
  debate: "多模型博弈",
  execute: "执行",
  verify: "验证",
  reject_node: "打回",
  pause_run: "暂停",
  cancel_run: "取消",
};

const ACTION_ALIASES: Array<{ action: IntentRouteAction; aliases: string[] }> = [
  { action: "answer_only", aliases: ["解释", "说明", "普通对话", "聊天", "润色", "改文案", "改文章"] },
  { action: "review", aliases: ["评审", "审查", "复核", "评估", "看看", "挑问题"] },
  { action: "debate", aliases: ["博弈", "对弈", "辩论", "PK", "pk", "互相反驳", "裁判"] },
  { action: "execute", aliases: ["执行", "改代码", "实现", "落地", "写文件", "创建"] },
  { action: "verify", aliases: ["验证", "测试", "跑测试", "构建", "检查"] },
  { action: "plan", aliases: ["方案", "计划", "规划"] },
  { action: "start_run", aliases: ["开始任务", "新任务", "盘查项目"] },
  { action: "continue_run", aliases: ["继续任务", "下一步"] },
  { action: "pause_run", aliases: ["暂停", "先停"] },
  { action: "cancel_run", aliases: ["取消", "不要继续"] },
  { action: "reject_node", aliases: ["打回", "重来", "不是这个"] },
];

export function intentActionLabel(action: IntentRouteAction): string {
  return ACTION_LABELS[action];
}

function findActionInText(text: string, preferredStart = 0): IntentRouteAction | null {
  const tail = text.slice(Math.max(0, preferredStart));
  for (const item of ACTION_ALIASES) {
    if (item.aliases.some((alias) => tail.includes(alias))) return item.action;
  }
  return null;
}

export function detectIntentCorrection(text: string): IntentCorrection | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const negativeIndex = Math.max(trimmed.indexOf("不是要"), trimmed.indexOf("不要"));
  const positiveSearchStart = negativeIndex >= 0
    ? negativeIndex + (trimmed.includes("不是要", negativeIndex) ? "不是要".length : "不要".length)
    : 0;
  const positiveIndexCandidates = [
    trimmed.indexOf("是要", positiveSearchStart),
    trimmed.indexOf("而是", positiveSearchStart),
    trimmed.indexOf("只是", positiveSearchStart),
  ].filter((i) => i >= 0);
  const positiveIndex = positiveIndexCandidates.length ? Math.min(...positiveIndexCandidates) : -1;

  if (negativeIndex >= 0 && positiveIndex > negativeIndex) {
    const predictedAction = findActionInText(trimmed.slice(negativeIndex, positiveIndex));
    const correctedAction = findActionInText(trimmed, positiveIndex);
    if (predictedAction && correctedAction && predictedAction !== correctedAction) {
      return { predictedAction, correctedAction, confidence: 0.9 };
    }
  }

  if (/别.*(执行|改代码|写文件|落地)/.test(trimmed) && /(只是|只想|只是让).*(解释|说明|看看|聊)/.test(trimmed)) {
    return { predictedAction: "execute", correctedAction: "answer_only", confidence: 0.86 };
  }

  if (/(不是|别).*(博弈|对弈|辩论|PK|pk)/.test(trimmed) && /(评审|评估|审查|复核|看看)/.test(trimmed)) {
    return { predictedAction: "debate", correctedAction: "review", confidence: 0.86 };
  }

  return null;
}
