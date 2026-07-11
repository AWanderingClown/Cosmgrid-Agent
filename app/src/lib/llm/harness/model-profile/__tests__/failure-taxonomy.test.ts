import { describe, expect, it } from "vitest";

import {
  failureKindFromEvalResult,
  failureKindFromHarnessVerdict,
  failureKindFromLlmErrorCategory,
  failureKindFromTaskOutcome,
  failureKindFromToolResult,
} from "../failure-taxonomy";

describe("model profile failure taxonomy", () => {
  it("maps no-tool completion and partial fabrication separately", () => {
    expect(failureKindFromHarnessVerdict({
      fabricationBand: "A",
      toolCallCount: 0,
      unverifiedPaths: 0,
      unverifiedUrls: 0,
      unverifiedCommands: 0,
      intentNoToolCall: true,
    })).toBe("no_tool_completion");

    expect(failureKindFromHarnessVerdict({
      fabricationBand: "B",
      toolCallCount: 1,
      unverifiedPaths: 1,
      unverifiedUrls: 0,
      unverifiedCommands: 0,
      intentNoToolCall: false,
    })).toBe("partial_fabrication");
  });

  it("maps tool error codes to stable failure kinds", () => {
    expect(failureKindFromToolResult({ toolName: "edit", status: "error", errorCode: "TOOL_INVALID_PARAMS" })).toBe("invalid_tool_args");
    expect(failureKindFromToolResult({ toolName: "bash", status: "error", errorCode: "TOOL_DOOM_LOOP" })).toBe("repeated_tool_call");
    expect(failureKindFromToolResult({ toolName: "lsp", status: "error", errorCode: "TOOL_DIAGNOSTIC" })).toBe("invalid_structured_output");
  });

  it("maps eval, outcome, and llm categories", () => {
    expect(failureKindFromEvalResult({ passed: false, failureCode: "EVIDENCE_INSUFFICIENT" })).toBe("partial_fabrication");
    expect(failureKindFromTaskOutcome({ outcome: "failed", interventionKind: null })).toBe("premature_completion");
    expect(failureKindFromLlmErrorCategory("context_overflow")).toBe("context_overflow");
  });
});
