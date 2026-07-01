import type { TFunction } from "i18next";
import type { DebateResult } from "@/lib/llm/debate-engine";
import type { ChatMessage } from "./types";

export interface FormattedDebateResult {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export function formatDebateResultMessage(args: {
  result: DebateResult;
  participantCount: number;
  modelNameFor: (modelId: string) => string;
  t: TFunction;
}): FormattedDebateResult {
  const usage = args.result.rounds.reduce(
    (acc, round) => ({
      inputTokens: acc.inputTokens + round.inputTokens,
      outputTokens: acc.outputTokens + round.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );

  const content = [
    args.participantCount === 1
      ? args.t("chat.debate.singleModelNotice")
      : args.t("chat.debate.completed", { count: args.participantCount }),
    "",
    "## 最终判断",
    args.result.finalSolution,
    "",
    "## 博弈过程",
    ...args.result.rounds.map((round, index) => [
      `### ${index + 1}. ${args.modelNameFor(round.modelId)} · ${round.role}`,
      round.content,
    ].join("\n")),
  ].join("\n");

  return { content, usage };
}

export function buildDebateTopic(args: {
  messages: ChatMessage[];
  userMessage: ChatMessage;
  maxHistoryMessages?: number;
  maxContentChars?: number;
}): string {
  const maxHistoryMessages = args.maxHistoryMessages ?? 6;
  const maxContentChars = args.maxContentChars ?? 1600;
  return [...args.messages.slice(-maxHistoryMessages), args.userMessage]
    .filter((m) => m.kind !== "receipt")
    .map((m) => `${m.role === "user" ? "用户" : "AI"}：${m.content.slice(0, maxContentChars)}`)
    .join("\n\n");
}
