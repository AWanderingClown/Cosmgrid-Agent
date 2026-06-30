import type { TurnIntentDecision, WorkflowSnapshot } from "./types";

const START_PROJECT_RE = /(看|读|扫|分析|了解).*(项目|代码|仓库|工程)|项目.*(看|读|分析)|read.*project|inspect.*project/i;
const PLAN_RE = /(方案|计划|规划|路线图|迭代|架构|设计|plan|roadmap|proposal|architecture)/i;
const REVIEW_RE = /(评审|审查|复核|检查方案|另一个模型|review|critique)/i;
const DEBATE_RE = /(对弈|博弈|反驳|多模型|比较方案|debate|compare options)/i;
const EXECUTE_RE = /(直接执行|开始执行|按.*做|照.*做|执行方案|开始实现|落地|改代码|修复|implement|execute|apply it|do it)/i;
const VERIFY_RE = /(验证|测试|跑测试|构建|编译|检查结果|build|test|verify|typecheck|lint)/i;
const PAUSE_RE = /(暂停|先停|等一下|pause|hold)/i;
const CANCEL_RE = /(取消|算了|停止这个任务|cancel|stop this)/i;
const REJECT_RE = /(不对|重来|不是这个|改一下方案|打回|reject|redo)/i;
const CONTINUE_RE = /^(继续|继续吧|下一步|go on|continue|next)$/i;
const QUESTION_RE = /(是什么|为什么|怎么理解|解释|说明|啥意思|what is|why|explain)/i;

function baseDecision(args: {
  action: TurnIntentDecision["action"];
  targetRunId: string | null;
  confidence: number;
  reason: string;
  evidenceTurnIds?: string[];
  patch?: TurnIntentDecision["patch"];
}): TurnIntentDecision {
  return {
    action: args.action,
    targetRunId: args.targetRunId,
    confidence: args.confidence,
    reason: args.reason,
    evidenceTurnIds: args.evidenceTurnIds ?? [],
    ...(args.patch ? { patch: args.patch } : {}),
  };
}

export function classifyTurnIntent(args: {
  text: string;
  activeRun: WorkflowSnapshot | null;
  recentTurnIds?: string[];
}): TurnIntentDecision {
  const text = args.text.trim();
  const activeRun = args.activeRun;
  const activeRunId = args.activeRun?.runId ?? null;

  if (!text) {
    return baseDecision({
      action: "answer_only",
      targetRunId: activeRunId,
      confidence: 0.9,
      reason: "用户没有输入有效任务内容。",
      evidenceTurnIds: args.recentTurnIds,
    });
  }

  if (CANCEL_RE.test(text)) {
    return baseDecision({
      action: "cancel_run",
      targetRunId: activeRunId,
      confidence: 0.92,
      reason: "用户明确要求取消或停止当前任务。",
      evidenceTurnIds: args.recentTurnIds,
    });
  }

  if (PAUSE_RE.test(text)) {
    return baseDecision({
      action: "pause_run",
      targetRunId: activeRunId,
      confidence: 0.9,
      reason: "用户要求暂停当前任务。",
      evidenceTurnIds: args.recentTurnIds,
    });
  }

  if (activeRun) {
    if (REJECT_RE.test(text)) {
      return baseDecision({
        action: "reject_node",
        targetRunId: activeRun.runId,
        confidence: 0.86,
        reason: "用户在已有任务里打回当前结果或要求调整。",
        evidenceTurnIds: args.recentTurnIds,
      });
    }

    if (EXECUTE_RE.test(text)) {
      return baseDecision({
        action: "approve_node",
        targetRunId: activeRun.runId,
        confidence: 0.94,
        reason: "用户明确要求执行当前方案或进入实现。",
        evidenceTurnIds: args.recentTurnIds,
        patch: { executionMode: "execute_directly" },
      });
    }

    if (REVIEW_RE.test(text)) {
      return baseDecision({
        action: "continue_run",
        targetRunId: activeRun.runId,
        confidence: 0.9,
        reason: "用户要求在当前任务里增加方案评审。",
        evidenceTurnIds: args.recentTurnIds,
        patch: { reviewRequested: true },
      });
    }

    if (DEBATE_RE.test(text)) {
      return baseDecision({
        action: "continue_run",
        targetRunId: activeRun.runId,
        confidence: 0.9,
        reason: "用户要求在当前任务里进行多模型博弈。",
        evidenceTurnIds: args.recentTurnIds,
        patch: { debateRequested: true },
      });
    }

    if (VERIFY_RE.test(text)) {
      return baseDecision({
        action: "continue_run",
        targetRunId: activeRun.runId,
        confidence: 0.88,
        reason: "用户要求验证当前任务结果。",
        evidenceTurnIds: args.recentTurnIds,
        patch: { verificationRequired: true },
      });
    }

    if (CONTINUE_RE.test(text)) {
      return baseDecision({
        action: "continue_run",
        targetRunId: activeRun.runId,
        confidence: activeRun.nextActions.length <= 1 ? 0.82 : 0.62,
        reason: activeRun.nextActions.length <= 1
          ? "当前任务只有一个明确下一步，用户要求继续。"
          : "用户要求继续，但当前任务有多个候选下一步，需要确认。",
        evidenceTurnIds: args.recentTurnIds,
      });
    }

    if (PLAN_RE.test(text)) {
      return baseDecision({
        action: "continue_run",
        targetRunId: activeRun.runId,
        confidence: 0.86,
        reason: "用户要求基于当前任务继续制定或调整方案。",
        evidenceTurnIds: args.recentTurnIds,
        patch: { executionMode: "plan_only" },
      });
    }
  }

  if (START_PROJECT_RE.test(text)) {
    return baseDecision({
      action: "start_run",
      targetRunId: null,
      confidence: 0.9,
      reason: "用户要求读取或理解项目，应该创建新的项目工作流。",
      evidenceTurnIds: args.recentTurnIds,
      patch: { objective: text, requestedOutcome: "理解项目并给出后续建议", executionMode: "plan_only" },
    });
  }

  if (PLAN_RE.test(text)) {
    return baseDecision({
      action: activeRun ? "continue_run" : "start_run",
      targetRunId: activeRunId,
      confidence: 0.84,
      reason: "用户要求制定方案或计划。",
      evidenceTurnIds: args.recentTurnIds,
      patch: { objective: text, requestedOutcome: "输出可执行方案", executionMode: "plan_only" },
    });
  }

  if (EXECUTE_RE.test(text)) {
    return baseDecision({
      action: activeRun ? "approve_node" : "start_run",
      targetRunId: activeRunId,
      confidence: activeRun ? 0.9 : 0.72,
      reason: activeRun ? "用户要求执行当前任务。" : "用户要求执行，但没有 active plan，需先建立任务上下文。",
      evidenceTurnIds: args.recentTurnIds,
      patch: { objective: text, requestedOutcome: "执行用户要求", executionMode: "execute_directly" },
    });
  }

  return baseDecision({
    action: QUESTION_RE.test(text) ? "answer_only" : "answer_only",
    targetRunId: activeRunId,
    confidence: QUESTION_RE.test(text) ? 0.86 : 0.68,
    reason: QUESTION_RE.test(text) ? "用户是普通解释性问题。" : "没有足够信号创建或推进任务，按普通问答处理。",
    evidenceTurnIds: args.recentTurnIds,
  });
}
