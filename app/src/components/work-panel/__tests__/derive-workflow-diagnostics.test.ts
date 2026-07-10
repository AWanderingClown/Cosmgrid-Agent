import { describe, expect, it } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "@/lib/workflow/code-task-template";
import type { ToolCallView } from "@/lib/work-artifact-views";
import type { ChatMessage } from "@/pages/chat/types";
import { deriveWorkflowDiagnostics } from "../derive-workflow-diagnostics";

function tool(overrides: Partial<ToolCallView>): ToolCallView {
  return {
    id: "tool-1",
    toolName: "bash",
    status: "success",
    shortSummary: "执行命令：pnpm test",
    summaryKey: "bash",
    summaryVars: {},
    detailPreview: "",
    detailFull: "",
    createdAt: "2026-07-07T00:00:00.000Z",
    durationMs: 10,
    messageId: "assistant-1",
    errorCode: null,
    nextActions: [],
    artifacts: [],
    ...overrides,
  };
}

describe("deriveWorkflowDiagnostics", () => {
  it("derives workflow phase, plan source, tool stats, and fallback facts from state", () => {
    const snapshot = createCodeTaskWorkflowSnapshot({
      runId: "run-1",
      conversationId: "conv-1",
      objective: "工程化收口",
      workspacePath: "/repo",
      executionMode: "execute_directly",
    });
    const withPlan = {
      ...snapshot,
      currentNodeId: "execute",
      context: {
        ...snapshot.context,
        activeSkill: {
          id: "plan_execution",
          label: "按方案执行",
          selectedAt: "2026-07-07T00:00:00.000Z",
          reason: "execute phase",
        },
        planSummary: "按桌面方案执行 Phase 1",
        debateSummary: "多模型博弈未完成，采用降级方案",
        planSource: {
          kind: "degraded_debate" as const,
          ref: "debate:session-1",
          summary: "按降级方案执行 Phase 1",
          phase: "debate" as const,
          boundAt: "2026-07-07T00:00:00.000Z",
          label: "降级方案",
        },
      },
    };
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "done",
        modelLabel: "Codex",
        switched: true,
        switchReason: { kind: "cooldown" },
        llmInvocations: [
          {
            modelId: "codex",
            modelName: "gpt-5.5",
            providerType: "codex-cli",
            providerKind: "cli",
            status: "cooldown",
            startedAt: "2026-07-07T00:00:00.000Z",
            endedAt: "2026-07-07T00:00:00.000Z",
            latencyMs: 0,
          },
          {
            modelId: "api-1",
            modelName: "kimi",
            providerType: "openai",
            providerKind: "api",
            status: "success",
            startedAt: "2026-07-07T00:00:01.000Z",
            endedAt: "2026-07-07T00:00:02.000Z",
            latencyMs: 1000,
          },
        ],
      },
    ];

    const view = deriveWorkflowDiagnostics({
      workflowSnapshot: withPlan,
      workflowEvents: [
        {
          id: "event-1",
          eventType: "workflow.created",
          createdAt: "2026-07-07T00:00:00.000Z",
          payloadJson: "{}",
        },
        {
          id: "event-2",
          eventType: "workflow.skill_selected",
          createdAt: "2026-07-07T00:01:00.000Z",
          payloadJson: "{\"skillId\":\"plan_execution\"}",
        },
      ],
      toolCalls: [
        tool({ id: "ok", status: "success" }),
        tool({ id: "bad", status: "error", shortSummary: "执行命令：pnpm build" }),
        tool({ id: "deny", status: "denied", shortSummary: "写入 PLAN.md" }),
      ],
      messages,
    });

    expect(view.hasWorkflow).toBe(true);
    expect(view.phase).toBe("execute");
    expect(view.objective).toBe("工程化收口");
    expect(view.planSource?.kind).toBe("degraded_debate");
    expect(view.latestWorkflowEvent).toBe("workflow.skill_selected");
    expect(view.workflowEventCount).toBe(2);
    expect(view.debateSummary).toContain("降级方案");
    expect(view.toolStats).toMatchObject({ total: 3, success: 1, error: 1, denied: 1 });
    expect(view.fallbackStats).toMatchObject({ total: 1, latestModel: "Codex", latestReason: "cooldown" });
    expect(view.llmStats).toMatchObject({ total: 2, error: 0, cooldown: 1, latestStatus: "success" });
    expect(view.layers.find((layer) => layer.id === "llm")?.status).toBe("warning");
    expect(view.layers.find((layer) => layer.id === "llm")?.detail).toBe("2 calls");
    expect(view.layers.find((layer) => layer.id === "tools")?.status).toBe("warning");
    expect(view.layers.find((layer) => layer.id === "skill")).toMatchObject({
      status: "active",
      detail: "按方案执行",
    });
    expect(view.layers.find((layer) => layer.id === "harness")?.status).toBe("ok");
  });

  it("returns explicit empty facts when there is no workflow", () => {
    const view = deriveWorkflowDiagnostics({
      workflowSnapshot: null,
      toolCalls: [],
      messages: [],
    });

    expect(view.hasWorkflow).toBe(false);
    expect(view.phase).toBeNull();
    expect(view.planSource).toBeNull();
    expect(view.toolStats.total).toBe(0);
    expect(view.fallbackStats.total).toBe(0);
    expect(view.layers.find((layer) => layer.id === "context")?.status).toBe("missing");
  });

  it("surfaces harness issues as a separate engineering layer", () => {
    const view = deriveWorkflowDiagnostics({
      workflowSnapshot: null,
      toolCalls: [],
      messages: [{
        id: "assistant-1",
        role: "assistant",
        content: "读过 src/App.tsx",
        harness: {
          unverifiedPaths: ["src/App.tsx"],
          pseudoToolNames: [],
        },
      }],
    });

    expect(view.layers.find((layer) => layer.id === "harness")).toMatchObject({
      status: "warning",
      detail: "1 issues",
    });
  });
});
