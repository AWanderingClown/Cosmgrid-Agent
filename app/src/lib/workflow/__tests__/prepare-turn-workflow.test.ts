import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "@/lib/workflow/code-task-template";

const mocks = vi.hoisted(() => ({
  getActiveByConversation: vi.fn(),
  createRun: vi.fn(),
  saveSnapshot: vi.fn(),
  appendEvent: vi.fn(),
  listExamples: vi.fn(),
  classifyTurnIntentWithJudge: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  workflowRuns: {
    getActiveByConversation: mocks.getActiveByConversation,
    create: mocks.createRun,
    saveSnapshot: mocks.saveSnapshot,
    appendEvent: mocks.appendEvent,
  },
  intentLearning: {
    listExamples: mocks.listExamples,
    recordFeedback: vi.fn(),
    upsertExample: vi.fn(),
  },
}));

vi.mock("@/lib/workflow/intent-judge", () => ({
  classifyTurnIntentWithJudge: mocks.classifyTurnIntentWithJudge,
}));

vi.mock("@/lib/app-settings", () => ({
  isDeveloperDiagnosticsEnabled: () => false,
}));

vi.mock("@/lib/workflow/intent-feedback", () => ({
  detectIntentCorrection: () => null,
  intentActionLabel: (action: string) => action,
}));

vi.mock("@/lib/workflow/intent-decay", () => ({
  downweightMisjudgedExampleInDb: vi.fn(),
}));

import { prepareTurnWorkflow } from "@/lib/workflow/prepare-turn-workflow";

describe("prepareTurnWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listExamples.mockResolvedValue([]);
    mocks.getActiveByConversation.mockResolvedValue(null);
  });

  it("leaves workflow untouched in pure single-model mode", async () => {
    const applySnapshot = vi.fn();

    const result = await prepareTurnWorkflow({
      conversationId: "conversation-1",
      projectId: null,
      pureMode: true,
      initialSnapshot: null,
      text: "start implementing",
      userId: "user-1",
      intentJudgeModel: null,
      workspacePath: "/workspace",
      applySnapshot,
    });

    expect(result).toEqual({
      snapshot: null,
      runId: null,
      shouldCompleteNode: false,
      intentDecision: null,
      intentJudgeCalled: false,
      workflowAdvanced: false,
    });
    expect(mocks.classifyTurnIntentWithJudge).not.toHaveBeenCalled();
    expect(applySnapshot).not.toHaveBeenCalled();
  });

  it("creates and applies a workflow when intent starts a run", async () => {
    mocks.classifyTurnIntentWithJudge.mockResolvedValue({
      action: "start_run",
      confidence: 0.95,
      reason: "new implementation task",
      patch: { objective: "Implement feature A" },
    });
    const applySnapshot = vi.fn();

    const result = await prepareTurnWorkflow({
      conversationId: "conversation-1",
      projectId: "project-1",
      pureMode: false,
      initialSnapshot: null,
      text: "Implement feature A",
      userId: "user-1",
      intentJudgeModel: null,
      workspacePath: "/workspace",
      applySnapshot,
    });

    expect(result.intentDecision?.action).toBe("start_run");
    expect(result.shouldCompleteNode).toBe(true);
    expect(result.workflowAdvanced).toBe(true);
    expect(result.runId).toBeTruthy();
    expect(mocks.createRun).toHaveBeenCalledOnce();
    expect(applySnapshot).toHaveBeenCalledWith(result.snapshot);
  });

  it("records an observed answer without advancing an existing workflow", async () => {
    const existing = createCodeTaskWorkflowSnapshot({
      runId: "run-1",
      conversationId: "conversation-1",
      objective: "Existing task",
      workspacePath: "/workspace",
    });
    mocks.classifyTurnIntentWithJudge.mockResolvedValue({
      action: "answer_only",
      confidence: 0.9,
      reason: "question only",
    });

    const result = await prepareTurnWorkflow({
      conversationId: "conversation-1",
      projectId: null,
      pureMode: false,
      initialSnapshot: existing,
      text: "Explain the current status",
      userId: "user-1",
      intentJudgeModel: null,
      workspacePath: "/workspace",
      applySnapshot: vi.fn(),
    });

    expect(result.snapshot).toBe(existing);
    expect(result.workflowAdvanced).toBe(false);
    expect(mocks.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowRunId: "run-1",
        eventType: "workflow.intent_observed",
      }),
    );
    expect(mocks.saveSnapshot).not.toHaveBeenCalled();
  });
});
