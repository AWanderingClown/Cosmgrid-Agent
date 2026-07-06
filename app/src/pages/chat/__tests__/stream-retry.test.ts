import { describe, expect, it } from "vitest";
import { decideStreamRetry } from "../stream-retry";

const dirtyVerdict = {
  unverifiedPaths: ["src/App.tsx"],
  pseudoToolNames: ["run_command"],
};

describe("decideStreamRetry", () => {
  it("does not retry in pure mode even when harness is dirty", () => {
    expect(
      decideStreamRetry({
        pureMode: true,
        harnessDirty: true,
        nudgeNeeded: false,
        attempt: 0,
        maxRetry: 1,
        hasTools: true,
        verdict: dirtyVerdict,
      }),
    ).toEqual({ shouldRetry: false });
  });

  it("uses harness correction before intent nudge", () => {
    const decision = decideStreamRetry({
      pureMode: false,
      harnessDirty: true,
      nudgeNeeded: true,
      attempt: 0,
      maxRetry: 1,
      hasTools: true,
      verdict: dirtyVerdict,
    });

    expect(decision.shouldRetry).toBe(true);
    if (!decision.shouldRetry) throw new Error("expected retry");
    expect(decision.notice).toBe("harness");
    expect(decision.retryPrompt).toContain("src/App.tsx");
  });

  it("uses nudge retry when harness is clean and budget remains", () => {
    const decision = decideStreamRetry({
      pureMode: false,
      harnessDirty: false,
      nudgeNeeded: true,
      attempt: 0,
      maxRetry: 1,
      hasTools: true,
      verdict: null,
    });

    expect(decision.shouldRetry).toBe(true);
    if (!decision.shouldRetry) throw new Error("expected retry");
    expect(decision.notice).toBe("nudge");
    expect(decision.retryPrompt).toContain("工具");
  });

  it("stops retrying after the retry budget is exhausted", () => {
    expect(
      decideStreamRetry({
        pureMode: false,
        harnessDirty: true,
        nudgeNeeded: false,
        attempt: 1,
        maxRetry: 1,
        hasTools: true,
        verdict: dirtyVerdict,
      }),
    ).toEqual({ shouldRetry: false });
  });
});
