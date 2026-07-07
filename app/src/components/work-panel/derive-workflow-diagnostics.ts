import type { ToolCallView } from "@/lib/work-artifact-views";
import { deriveWorkflowAuditSummary, type WorkflowAuditEventLike } from "@/lib/workflow/audit";
import type { WorkflowSnapshot } from "@/lib/workflow/types";
import type { ChatMessage } from "@/pages/chat/types";

export interface WorkflowDiagnosticsView {
  layers: Array<{
    id: string;
    label: string;
    status: "ok" | "active" | "missing" | "warning";
    detail: string;
  }>;
  hasWorkflow: boolean;
  objective: string | null;
  phase: string | null;
  status: string | null;
  executionMode: string | null;
  latestWorkflowEvent: string | null;
  workflowEventCount: number;
  planSource: {
    kind: string;
    path: string | null;
    label: string | null;
  } | null;
  planSummary: string | null;
  debateSummary: string | null;
  toolStats: {
    total: number;
    success: number;
    error: number;
    denied: number;
    latest: string | null;
  };
  fallbackStats: {
    total: number;
    latestModel: string | null;
    latestReason: string | null;
  };
  llmStats: {
    total: number;
    error: number;
    cooldown: number;
    latestStatus: string | null;
  };
}

function truncate(text: string | null | undefined, max = 180): string | null {
  if (!text) return null;
  const compact = text.trim().replace(/\s+/g, " ");
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function currentPhase(snapshot: WorkflowSnapshot | null): string | null {
  if (!snapshot) return null;
  const node = snapshot.nodes.find((n) => n.id === snapshot.currentNodeId);
  return node?.phase ?? snapshot.currentNodeId ?? snapshot.status;
}

function switchReason(reason: ChatMessage["switchReason"]): string | null {
  if (!reason) return null;
  if (reason.kind === "cooldown") return "cooldown";
  if (reason.kind === "recovery") return "recovery";
  return reason.category;
}

function harnessIssueCount(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    const h = message.harness;
    if (!h) return sum;
    return sum
      + h.unverifiedPaths.length
      + (h.unverifiedUrls?.length ?? 0)
      + (h.unverifiedCommands?.length ?? 0)
      + h.pseudoToolNames.length
      + (h.fabricatedUsageCount ? 1 : 0);
  }, 0);
}

export function deriveWorkflowDiagnostics(args: {
  workflowSnapshot: WorkflowSnapshot | null;
  workflowEvents?: readonly WorkflowAuditEventLike[];
  toolCalls: readonly ToolCallView[];
  messages: readonly ChatMessage[];
}): WorkflowDiagnosticsView {
  const snapshot = args.workflowSnapshot;
  const audit = snapshot
    ? deriveWorkflowAuditSummary({ snapshot, events: args.workflowEvents ?? [] })
    : null;
  const success = args.toolCalls.filter((call) => call.status === "success").length;
  const error = args.toolCalls.filter((call) => call.status === "error" || call.status === "timeout").length;
  const denied = args.toolCalls.filter((call) => call.status === "denied" || call.status === "awaiting_approval").length;
  const latestTool = args.toolCalls.at(-1) ?? null;
  const fallbackTurns = args.messages.filter((message) => message.role === "assistant" && message.switched);
  const llmInvocations = args.messages.flatMap((message) => message.llmInvocations ?? []);
  const latestFallback = fallbackTurns.at(-1) ?? null;
  const latestInvocation = llmInvocations.at(-1) ?? null;
  const llmErrorTotal = llmInvocations.filter((event) => event.status === "error").length;
  const llmCooldownTotal = llmInvocations.filter((event) => event.status === "cooldown").length;
  const harnessIssues = harnessIssueCount(args.messages);
  const planSource = snapshot?.context.planSource ?? null;
  const activeSkill = snapshot?.context.activeSkill ?? null;
  const hasMemoryOrRagContext = !!snapshot?.context.planSummary || !!snapshot?.context.debateSummary;
  const toolTotal = args.toolCalls.length;
  const fallbackTotal = fallbackTurns.length;

  return {
    layers: [
      {
        id: "llm",
        label: "LLM",
        status: llmErrorTotal > 0 || fallbackTotal > 0 ? "warning" : (llmInvocations.length > 0 ? "active" : "ok"),
        detail: llmInvocations.length > 0
          ? `${llmInvocations.length} calls`
          : (fallbackTotal > 0 ? `${fallbackTotal} fallback` : "primary path"),
      },
      {
        id: "routing",
        label: "Routing",
        status: fallbackTotal > 0 ? "active" : "ok",
        detail: latestFallback?.modelLabel ?? "no switch",
      },
      {
        id: "context",
        label: "Context",
        status: snapshot ? "active" : "missing",
        detail: audit?.currentPhase ?? (snapshot ? currentPhase(snapshot) ?? "workflow" : "no workflow"),
      },
      {
        id: "memory",
        label: "Memory",
        status: planSource ? "active" : "missing",
        detail: planSource?.kind ?? "no plan source",
      },
      {
        id: "rag",
        label: "RAG",
        status: hasMemoryOrRagContext ? "active" : "missing",
        detail: hasMemoryOrRagContext ? "context available" : "no retrieved context",
      },
      {
        id: "tools",
        label: "Tools",
        status: toolTotal > 0 ? (error > 0 ? "warning" : "active") : "missing",
        detail: `${toolTotal} calls`,
      },
      {
        id: "skill",
        label: "Skill",
        status: activeSkill ? "active" : "missing",
        detail: activeSkill?.label ?? "no active skill",
      },
      {
        id: "harness",
        label: "Harness",
        status: harnessIssues > 0 ? "warning" : "ok",
        detail: harnessIssues > 0 ? `${harnessIssues} issues` : "clean",
      },
      {
        id: "workflow",
        label: "Workflow",
        status: snapshot ? "active" : "missing",
        detail: snapshot?.status ?? "no workflow",
      },
    ],
    hasWorkflow: !!snapshot,
    objective: snapshot?.intent.objective ?? null,
    phase: audit?.currentPhase ?? currentPhase(snapshot),
    status: audit?.status ?? snapshot?.status ?? null,
    executionMode: audit?.executionMode ?? snapshot?.intent.executionMode ?? null,
    latestWorkflowEvent: audit?.latestEventType ?? null,
    workflowEventCount: audit?.timeline.length ?? 0,
    planSource: planSource
      ? {
          kind: planSource.kind,
          path: planSource.path ?? null,
          label: planSource.label ?? null,
        }
      : null,
    planSummary: truncate(snapshot?.context.planSummary),
    debateSummary: truncate(snapshot?.context.debateSummary),
    toolStats: {
      total: args.toolCalls.length,
      success,
      error,
      denied,
      latest: latestTool?.shortSummary ?? null,
    },
    fallbackStats: {
      total: fallbackTurns.length,
      latestModel: latestFallback?.modelLabel ?? null,
      latestReason: switchReason(latestFallback?.switchReason),
    },
    llmStats: {
      total: llmInvocations.length,
      error: llmErrorTotal,
      cooldown: llmCooldownTotal,
      latestStatus: latestInvocation?.status ?? null,
    },
  };
}
