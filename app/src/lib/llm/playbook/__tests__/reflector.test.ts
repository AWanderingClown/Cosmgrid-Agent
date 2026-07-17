// 阶段5 Playbook — Reflector 纯函数测试（2026-07-17 接线时补齐，README 计划的 5 case）。

import { describe, expect, it } from "vitest";
import { reflectPlaybookEvents } from "../reflector";
import type { PlaybookEvent } from "../types";

function makeEvent(over: Partial<PlaybookEvent>): PlaybookEvent {
  return {
    id: "evt-1",
    projectId: "p-1",
    conversationId: "conv-1",
    messageId: null,
    kind: "outcome_failed",
    payloadJson: "{}",
    occurredAt: "2026-07-17T00:00:00.000Z",
    createdAt: "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

describe("reflectPlaybookEvents", () => {
  it("checkpoint_failed → failedAttempts/doNotRepeat 各提炼 lesson（confidence=0.9）", () => {
    const out = reflectPlaybookEvents([
      makeEvent({
        kind: "checkpoint_failed",
        payloadJson: JSON.stringify({
          failedAttempts: ["直接改 db.execute 会顶掉测试 mock"],
          doNotRepeat: ["不要用 dvh 单位"],
        }),
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.kind === "lesson" && c.confidence === 0.9)).toBe(true);
    expect(out[0]!.title).toContain("从失败中学习");
    expect(out[1]!.title).toContain("不要重复");
    expect(out[1]!.sourceEventIds).toEqual(["evt-1"]);
  });

  it("summary_dropped → keyDecisions 提炼 context(0.7) + openThreads 提炼 lesson(0.5)", () => {
    const out = reflectPlaybookEvents([
      makeEvent({
        kind: "summary_dropped",
        payloadJson: JSON.stringify({
          keyDecisions: ["用 SQLite 不用 Postgres"],
          openThreads: ["价格表迁移还没收口"],
        }),
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "context", confidence: 0.7 });
    expect(out[1]).toMatchObject({ kind: "lesson", confidence: 0.5 });
  });

  it("outcome_failed → failureCode 提炼 lesson(0.8)", () => {
    const out = reflectPlaybookEvents([
      makeEvent({ kind: "outcome_failed", payloadJson: JSON.stringify({ failureCode: "no_tool_evidence" }) }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "lesson", confidence: 0.8 });
    expect(out[0]!.title).toBe("失败模式：no_tool_evidence");
  });

  it("outcome_needs_user → interventionKind 提炼 preference(0.6)", () => {
    const out = reflectPlaybookEvents([
      makeEvent({ kind: "outcome_needs_user", payloadJson: JSON.stringify({ interventionKind: "awaiting_user" }) }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "preference", confidence: 0.6 });
  });

  it("tool_success / outcome_passed → skip；坏 payload 不中断整体", () => {
    const out = reflectPlaybookEvents([
      makeEvent({ kind: "tool_success" }),
      makeEvent({ kind: "outcome_passed" }),
      makeEvent({ id: "evt-bad", kind: "checkpoint_failed", payloadJson: "{not json" }),
      makeEvent({ id: "evt-ok", kind: "outcome_failed", payloadJson: JSON.stringify({ failureCode: "x" }) }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceEventIds).toEqual(["evt-ok"]);
  });
});
