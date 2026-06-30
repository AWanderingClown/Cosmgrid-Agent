import { describe, expect, it } from "vitest";
import { detectIntentCorrection, intentActionLabel } from "../intent-feedback";

describe("detectIntentCorrection", () => {
  it("detects explicit user correction from debate to review", () => {
    const correction = detectIntentCorrection("不是，我不是要博弈，我是要评审");

    expect(correction).toEqual({
      predictedAction: "debate",
      correctedAction: "review",
      confidence: 0.9,
    });
  });

  it("detects explanation-only correction from execute", () => {
    const correction = detectIntentCorrection("别执行，我只是让你解释一下");

    expect(correction?.predictedAction).toBe("execute");
    expect(correction?.correctedAction).toBe("answer_only");
  });

  it("returns null when there is no clear correction", () => {
    expect(detectIntentCorrection("这个方案继续优化一下")).toBeNull();
  });

  it("has stable labels for saved examples", () => {
    expect(intentActionLabel("review")).toBe("评审");
    expect(intentActionLabel("debate")).toBe("多模型博弈");
  });
});
