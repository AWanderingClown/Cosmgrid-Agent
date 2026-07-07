import { describe, expect, it } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "../code-task-template";
import { deriveWorkflowAuditSummary } from "../audit";

function snapshot() {
  const base = createCodeTaskWorkflowSnapshot({
    runId: "run-1",
    conversationId: "conv-1",
    objective: "工程化收口",
    workspacePath: "/repo",
    executionMode: "execute_directly",
  });

  return {
    ...base,
    currentNodeId: "execute",
    context: {
      ...base.context,
      activeSkill: {
        id: "plan_execution",
        label: "按方案执行",
        selectedAt: "2026-07-07T00:00:00.000Z",
        reason: "workflow phase execute",
      },
      planSummary: "按降级方案执行",
      debateSummary: "多模型博弈未完成，采用降级方案",
      planSource: {
        kind: "debate_degraded" as const,
        phase: "debate" as const,
        capturedAt: "2026-07-07T00:00:00.000Z",
        label: "降级方案",
      },
    },
  };
}

describe("deriveWorkflowAuditSummary", () => {
  it("turns workflow snapshot and events into one auditable state fact", () => {
    const summary = deriveWorkflowAuditSummary({
      snapshot: snapshot(),
      events: [
        {
          id: "event-1",
          eventType: "workflow.created",
          createdAt: "2026-07-07T00:00:00.000Z",
          payloadJson: JSON.stringify({ status: "running", currentPhase: "read_project" }),
        },
        {
          id: "event-2",
          eventType: "workflow.plan_source_attached",
          createdAt: "2026-07-07T00:01:00.000Z",
          payloadJson: JSON.stringify({ path: "/Users/me/Desktop/PLAN.md" }),
        },
        {
          id: "event-3",
          eventType: "workflow.skill_selected",
          createdAt: "2026-07-07T00:02:00.000Z",
          payloadJson: JSON.stringify({ skillId: "plan_execution", reason: "workflow phase execute" }),
        },
      ],
    });

    expect(summary).toMatchObject({
      runId: "run-1",
      currentPhase: "execute",
      status: "running",
      objective: "工程化收口",
      planSourceKind: "debate_degraded",
      planSourceLabel: "降级方案",
      activeSkillId: "plan_execution",
      activeSkillLabel: "按方案执行",
      degraded: true,
      latestEventType: "workflow.skill_selected",
    });
    expect(summary.eventCounts).toMatchObject({
      "workflow.created": 1,
      "workflow.plan_source_attached": 1,
      "workflow.skill_selected": 1,
    });
    expect(summary.timeline.map((event) => event.eventType)).toEqual([
      "workflow.created",
      "workflow.plan_source_attached",
      "workflow.skill_selected",
    ]);
  });

  it("survives malformed event payloads without losing the audit timeline", () => {
    const summary = deriveWorkflowAuditSummary({
      snapshot: snapshot(),
      events: [{
        id: "bad",
        eventType: "workflow.intent_observed",
        createdAt: "2026-07-07T00:00:00.000Z",
        payloadJson: "{bad-json",
      }],
    });

    expect(summary.timeline[0]).toMatchObject({
      eventType: "workflow.intent_observed",
      payload: null,
      payloadParseError: true,
    });
    expect(summary.latestEventType).toBe("workflow.intent_observed");
  });
});
