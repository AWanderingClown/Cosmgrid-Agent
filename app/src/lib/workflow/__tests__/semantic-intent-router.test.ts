import { describe, expect, it } from "vitest";
import {
  BUILTIN_INTENT_EXAMPLES,
  buildIntentJudgeContext,
  routeTurnIntentSemantically,
} from "../semantic-intent-router";

describe("routeTurnIntentSemantically", () => {
  it("routes natural review requests without fixed keywords", () => {
    const result = routeTurnIntentSemantically("你让另外一个 AI 来评估一下这个方案");

    expect(result.top?.action).toBe("review");
    expect(result.top?.score).toBeGreaterThanOrEqual(0.5);
    expect(result.noMatch).toBe(false);
  });

  it("distinguishes debate from a plain review", () => {
    const debate = routeTurnIntentSemantically("让几个模型站不同立场互相反驳，最后给我裁判结论");
    const review = routeTurnIntentSemantically("找个审查者帮我看看这个方案有没有漏洞");

    expect(debate.top?.action).toBe("debate");
    expect(review.top?.action).toBe("review");
  });

  it("keeps article revision as answer_only instead of debate or execute", () => {
    const result = routeTurnIntentSemantically("这篇公众号软文推得太硬了，改得自然一点");

    expect(result.top?.action).toBe("answer_only");
    expect(result.candidates.some((c) => c.action === "debate" && c.score >= result.top!.score)).toBe(false);
    expect(result.candidates.some((c) => c.action === "execute" && c.score >= result.top!.score)).toBe(false);
  });

  it("returns no_match for unrelated vague chat", () => {
    const result = routeTurnIntentSemantically("哈哈这个挺有意思的");

    expect(result.noMatch).toBe(true);
    expect(result.confidence).toBeLessThan(0.65);
  });

  it("builds a compact judge context with examples and scores", () => {
    const result = routeTurnIntentSemantically("按这个方案开始改代码");
    const context = buildIntentJudgeContext(result);

    expect(context).toContain("语义样例路由");
    expect(context).toContain("execute");
    expect(context).toContain("score=");
  });

  it("keeps enough builtin coverage for the first workflow actions", () => {
    const actions = new Set(BUILTIN_INTENT_EXAMPLES.map((e) => e.action));

    expect(actions).toEqual(
      new Set([
        "answer_only",
        "start_run",
        "continue_run",
        "plan",
        "review",
        "debate",
        "execute",
        "verify",
        "reject_node",
        "pause_run",
        "cancel_run",
      ]),
    );
  });
});
