import { toolExecutions, type ToolExecutionRow } from "@/lib/db";
import type { LanguageModel } from "../provider-factory";
import {
  classifyFabricationGate,
  FABRICATION_CONFIDENCE_THRESHOLD,
  judgeFabrication,
} from "./fabrication-judge";
import { buildFabricationEvidenceSummary, selectRowsForMessage } from "./fabrication-evidence";
import { evaluateHarness, isClean, type HarnessVerdict } from "./feedback";
import type { ExecRecord, FetchRecord, ReadRecord } from "./verify-claims";

function filterToolRecordsSince(
  rows: ToolExecutionRow[],
  sinceIso: string | null,
  toolNames: readonly string[],
): { input: string; status: string }[] {
  const sinceTs = sinceIso ? Date.parse(sinceIso) : Number.NEGATIVE_INFINITY;
  return rows
    .filter((r) => toolNames.includes(r.toolName) && Date.parse(r.createdAt) >= sinceTs)
    .map((r) => ({ input: r.input, status: r.status }));
}

function filterReadRecordsSince(rows: ToolExecutionRow[], sinceIso: string | null): ReadRecord[] {
  return filterToolRecordsSince(rows, sinceIso, ["read"]);
}

function filterFetchRecordsSince(rows: ToolExecutionRow[], sinceIso: string | null): FetchRecord[] {
  return filterToolRecordsSince(rows, sinceIso, ["web_fetch"]);
}

function filterExecRecordsSince(rows: ToolExecutionRow[], sinceIso: string | null): ExecRecord[] {
  return filterToolRecordsSince(rows, sinceIso, ["bash", "grep", "web_search"]);
}

async function runFabricationJudgeStage(
  all: ToolExecutionRow[],
  verdict: HarnessVerdict,
  args: {
    content: string;
    sinceIso: string | null;
    actualToolCallCount: number;
    finishReason: string;
    assistantMessageId: string | null;
    judgeModel: LanguageModel | null;
  },
): Promise<HarnessVerdict> {
  const gate = classifyFabricationGate({
    regexClean: true,
    finishReason: args.finishReason,
    toolCallCount: args.actualToolCallCount,
    content: args.content,
  });
  if (gate === false || !args.judgeModel) return verdict;

  const rowsForMessage = selectRowsForMessage(all, {
    assistantMessageId: args.assistantMessageId,
    sinceIso: args.sinceIso,
  });
  const summary = buildFabricationEvidenceSummary(rowsForMessage);
  const judgement = await judgeFabrication(args.content, args.judgeModel, summary);
  if (judgement.fabricated && judgement.confidence >= FABRICATION_CONFIDENCE_THRESHOLD) {
    return {
      ...verdict,
      fabricationSuspected: {
        claimedActions: judgement.claimedActions,
        reason: judgement.reason,
      },
    };
  }
  return verdict;
}

export async function evaluateConversationHarness(args: {
  conversationId: string | null;
  content: string;
  sinceIso: string | null;
  actualToolCallCount?: number;
  assistantMessageId?: string | null;
  finishReason?: string | null;
  judgeModel?: LanguageModel | null;
  onRowsLoaded?: (rows: ToolExecutionRow[]) => void;
}): Promise<HarnessVerdict | null> {
  if (!args.conversationId || !args.content.trim()) return null;
  try {
    const all = await toolExecutions.listByConversation(args.conversationId);
    args.onRowsLoaded?.(all);

    const verdict = evaluateHarness(
      args.content,
      filterReadRecordsSince(all, args.sinceIso),
      args.actualToolCallCount ?? 0,
      filterFetchRecordsSince(all, args.sinceIso),
      filterExecRecordsSince(all, args.sinceIso),
    );
    if (!isClean(verdict)) return verdict;

    return await runFabricationJudgeStage(all, verdict, {
      content: args.content,
      sinceIso: args.sinceIso,
      actualToolCallCount: args.actualToolCallCount ?? 0,
      finishReason: args.finishReason ?? "stop",
      assistantMessageId: args.assistantMessageId ?? null,
      judgeModel: args.judgeModel ?? null,
    });
  } catch {
    return null;
  }
}
