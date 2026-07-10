import { describe, expect, it } from "vitest";
import { buildOrchestratorPlanPrompt } from "../orchestrator-plan-prompt";

describe("buildOrchestratorPlanPrompt", () => {
  it("把三段输入拼进 prompt 正文", () => {
    const prompt = buildOrchestratorPlanPrompt({
      roleMenu: "  - leader：团队 Leader",
      prevPlan: "（还没有规划过角色，这是第一次）",
      transcript: "[user] 你好",
    });
    expect(prompt).toContain("leader：团队 Leader");
    expect(prompt).toContain("还没有规划过角色");
    expect(prompt).toContain("[user] 你好");
    expect(prompt).toContain("角色团队 Leader");
  });
});
