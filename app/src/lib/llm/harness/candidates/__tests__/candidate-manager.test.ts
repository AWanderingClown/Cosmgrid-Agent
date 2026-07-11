import { describe, expect, it } from "vitest";

import {
  canAutoApplyEditSurface,
  deriveCandidateDecision,
  summarizeCandidateDiff,
} from "../candidate-manager";

describe("harness candidate manager", () => {
  it("blocks unsafe edit surfaces from automatic application", () => {
    expect(canAutoApplyEditSurface("skill_instruction")).toBe(true);
    expect(canAutoApplyEditSurface("permission_policy")).toBe(false);
    expect(canAutoApplyEditSurface("eval_grader")).toBe(false);
    expect(canAutoApplyEditSurface("command_safety")).toBe(false);
  });

  it("requires held-out and safety results before acceptance", () => {
    expect(deriveCandidateDecision({
      heldInPassed: true,
      heldOutPassed: false,
      safetyPassed: true,
      approvedByUser: true,
    })).toEqual({ status: "rejected", reason: "held-out failed" });

    expect(deriveCandidateDecision({
      heldInPassed: true,
      heldOutPassed: true,
      safetyPassed: true,
      approvedByUser: false,
    })).toEqual({ status: "pending_approval", reason: "awaiting user approval" });
  });

  it("summarizes candidate edits without exposing full diff as the only signal", () => {
    expect(summarizeCandidateDiff([
      { surface: "skill_instruction", diff: "+ require tool evidence" },
      { surface: "retry_policy", diff: "+ maxRetries=1" },
    ])).toEqual("2 edits: skill_instruction, retry_policy");
  });
});
