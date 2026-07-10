import { classifyTurnIntentWithJudge } from "@/lib/workflow/intent-judge";
import type { TurnIntentDecision, WorkflowSnapshot } from "@/lib/workflow/types";
import { classifyMessageComplexity, type MessageComplexity } from "./message-router";
import type { LanguageModel } from "./provider-factory";

export interface PrepareSemanticCacheTurnArgs {
  text: string;
  pureMode: boolean;
  smartRoutingEnabled: boolean;
  workspacePath: string | null;
  workflowSnapshot: WorkflowSnapshot | null;
  intentJudgeCalledThisTurn: boolean;
  turnIntentDecision: TurnIntentDecision | null;
  intentJudgeModel: LanguageModel | null;
}

export interface PreparedSemanticCacheTurn {
  taskRole: MessageComplexity;
  cacheIntent: TurnIntentDecision;
  cacheEligible: boolean;
}

function pureModeAnswerOnlyDecision(): TurnIntentDecision {
  return {
    action: "answer_only",
    targetRunId: null,
    confidence: 1,
    reason: "pure-single-model-mode",
    evidenceTurnIds: [],
  };
}

export async function prepareSemanticCacheTurn(
  args: PrepareSemanticCacheTurnArgs,
): Promise<PreparedSemanticCacheTurn> {
  const taskRole = classifyMessageComplexity(args.text);
  const cacheIntent = args.pureMode
    ? pureModeAnswerOnlyDecision()
    : args.intentJudgeCalledThisTurn && args.turnIntentDecision
      ? args.turnIntentDecision
      : await classifyTurnIntentWithJudge({
        text: args.text,
        activeRun: args.workflowSnapshot,
        model: args.intentJudgeModel,
      });

  return {
    taskRole,
    cacheIntent,
    cacheEligible: !args.pureMode
      && args.smartRoutingEnabled
      && !args.workspacePath
      && cacheIntent.action === "answer_only",
  };
}
