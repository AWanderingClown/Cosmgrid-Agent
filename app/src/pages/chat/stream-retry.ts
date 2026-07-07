import {
  buildCorrectionPrompt,
  buildIntentNudgePrompt,
  type HarnessVerdict,
} from "@/lib/llm/harness/feedback";

export type StreamRetryDecision =
  | { shouldRetry: false }
  | { shouldRetry: true; notice: "harness" | "nudge"; retryPrompt: string; forceToolChoice: boolean };

// 修订（2026-07-07，真实问题）：之前只有 nudge（模型嘴上说要做但 0 工具调用）这条分支会在
// 重答时把 toolChoice 锁死成 "required"；harness 分支（模型已经编造了具体声称）只在纠正
// 话术里用文字请求"请真正调用工具"，API 层仍是 "auto"——模型完全可以在重答时继续不调用
// 任何工具、只是换一种说法蒙混过关（甚至换个说法就绕开了 claim 正则，"抓到"了但没真正变
// 诚实）。harness 分支的信号比 nudge 更强（已经编了，不是"嘴上说说"），纠正力度不该比
// nudge 弱。现在两条分支只要 hasTools 就都在重答时强制 toolChoice:"required"——
// 没工具时无从强制，交给纠正话术里"直说做不到"的口径。
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
      forceToolChoice: args.hasTools,
    };
  }

  return {
    shouldRetry: true,
    notice: "nudge",
    retryPrompt: buildIntentNudgePrompt(),
    forceToolChoice: args.hasTools,
  };
}
