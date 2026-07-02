import {
  buildCorrectionPrompt,
  buildIntentNudgePrompt,
  type HarnessVerdict,
} from "@/lib/llm/harness/feedback";

export type StreamRetryDecision =
  | { shouldRetry: false }
  | { shouldRetry: true; notice: "harness" | "nudge"; retryPrompt: string };

export function decideStreamRetry(args: {
  pureMode: boolean;
  harnessDirty: boolean;
  nudgeNeeded: boolean;
  attempt: number;
  maxRetry: number;
  hasTools: boolean;
  verdict: HarnessVerdict | null;
}): StreamRetryDecision {
  if (args.pureMode || (!args.harnessDirty && !args.nudgeNeeded) || args.attempt >= args.maxRetry) {
    return { shouldRetry: false };
  }

  if (args.harnessDirty && args.verdict) {
    return {
      shouldRetry: true,
      notice: "harness",
      retryPrompt: buildCorrectionPrompt(args.verdict, { hasTools: args.hasTools }),
    };
  }

  return {
    shouldRetry: true,
    notice: "nudge",
    retryPrompt: buildIntentNudgePrompt(),
  };
}
