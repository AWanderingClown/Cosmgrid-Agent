import { describe, expect, it } from "vitest";
import { shouldRunDebateTurn } from "@/pages/chat/debate-runtime";

describe("shouldRunDebateTurn", () => {
  it("never starts debate in pure single-model mode", () => {
    expect(
      shouldRunDebateTurn({
        pureMode: true,
        text: "让几个模型互相反驳并裁判",
        intentDecision: {
          action: "continue_run",
          targetRunId: null,
          confidence: 1,
          reason: "explicit",
          evidenceTurnIds: [],
          patch: { debateRequested: true },
        },
      }),
    ).toBe(false);
  });

  it("starts from either the intent decision or an explicit user request", () => {
    expect(
      shouldRunDebateTurn({
        pureMode: false,
        text: "继续",
        intentDecision: {
          action: "continue_run",
          targetRunId: null,
          confidence: 1,
          reason: "intent",
          evidenceTurnIds: [],
          patch: { debateRequested: true },
        },
      }),
    ).toBe(true);

    expect(
      shouldRunDebateTurn({
        pureMode: false,
        text: "开始多模型对弈，互相反驳后裁判",
        intentDecision: null,
      }),
    ).toBe(true);
  });

  it("does not start for an ordinary chat turn", () => {
    expect(
      shouldRunDebateTurn({
        pureMode: false,
        text: "解释一下现在的进度",
        intentDecision: null,
      }),
    ).toBe(false);
  });
});
