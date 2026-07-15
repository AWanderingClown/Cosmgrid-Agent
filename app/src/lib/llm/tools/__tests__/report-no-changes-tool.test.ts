import { describe, it, expect } from "vitest";
import { reportNoChangesTool } from "../report-no-changes-tool";
import type { ToolContext } from "../types";

const ctx: ToolContext = { workspacePath: "" };

// 2026-07-15 review 修复：execute 阶段"合法零工具调用"逃生舱。node-verifier.ts 的
// verifyNodeOutcome 要求 execute 阶段有 toolCallCount > 0 才算有真实证据；模型合理判断
// "复查后不需要改动"时，调用这个工具本身就是一次真实的、会落审计的工具调用，天然满足
// hasToolEvidence 判定，不用靠文本关键词猜测。
describe("reportNoChangesTool", () => {
  it("成功返回，把 reason 带进 output", async () => {
    const res = await reportNoChangesTool.execute(
      { reason: "复查后确认当前实现已经满足需求，不需要改动" },
      ctx,
    );
    expect(res.status).toBe("success");
    expect(res.output).toContain("复查后确认当前实现已经满足需求，不需要改动");
  });

  it("只读工具，security.kind 是 none——不受任何阶段能力门控限制", () => {
    expect(reportNoChangesTool.readOnly).toBe(true);
    expect(reportNoChangesTool.security).toEqual({ kind: "none" });
  });

  it("reason 是必填项", () => {
    expect(() => reportNoChangesTool.parameters.parse({ reason: "" })).toThrow();
    expect(() => reportNoChangesTool.parameters.parse({})).toThrow();
  });
});
