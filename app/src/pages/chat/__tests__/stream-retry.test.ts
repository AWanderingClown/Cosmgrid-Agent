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

  // 真实问题（2026-07-07）：之前只有 nudge 分支会强制 toolChoice:"required"，harness
  // 分支（模型已经编了具体声称）只在话术里"请"它真调用，API 层仍是 auto——模型完全可以
  // 重答时继续不调用任何工具、换个说法蒙混过关。harness 信号比 nudge 更强，纠正力度不该更弱。
  it("harness 分支有工具时也强制 toolChoice required，不是只有 nudge 才强制", () => {
    const decision = decideStreamRetry({
      pureMode: false,
      harnessDirty: true,
      nudgeNeeded: false,
      attempt: 0,
      maxRetry: 1,
      hasTools: true,
      verdict: dirtyVerdict,
    });
    expect(decision.shouldRetry).toBe(true);
    if (!decision.shouldRetry) throw new Error("expected retry");
    expect(decision.forceToolChoice).toBe(true);
  });

  it("没工具时无从强制，forceToolChoice 为 false", () => {
    const decision = decideStreamRetry({
      pureMode: false,
      harnessDirty: true,
      nudgeNeeded: false,
      attempt: 0,
      maxRetry: 1,
      hasTools: false,
      verdict: dirtyVerdict,
    });
    expect(decision.shouldRetry).toBe(true);
    if (!decision.shouldRetry) throw new Error("expected retry");
    expect(decision.forceToolChoice).toBe(false);
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
    expect(decision.forceToolChoice).toBe(true);
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
