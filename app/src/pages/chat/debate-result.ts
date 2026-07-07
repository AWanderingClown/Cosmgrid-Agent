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

export function isFullDebateResult(result: DebateResult): boolean {
  const roles = new Set(result.rounds.map((round) => round.role));
  return roles.has("solver") && [...roles].some((role) => role.startsWith("critic")) && roles.has("judge");
}

export function formatDebateResultMessage(args: {
  result: DebateResult;
  participantCount: number;
  modelNameFor: (modelId: string) => string;
  t: TFunction;
}): FormattedDebateResult {
  const hasFullDebate = isFullDebateResult(args.result);
  const usage = args.result.rounds.reduce(
    (acc, round) => ({
      inputTokens: acc.inputTokens + round.inputTokens,
      outputTokens: acc.outputTokens + round.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );

  // UI 修复（2026-07-02，用户反馈）：博弈的中间产物（每个参与者的完整 solver/critic/judge
  // 输出）不该跟"最终判断"平铺在一起刷屏——包进 <debate_process> 标签，parse-thinking.ts
  // 识别后渲染成默认折叠的小字块（跟 <think> 思考过程同一套折叠机制），只有"最终判断"
  // 直接展示在正文里。
  const content = [
    args.participantCount === 1
      ? args.t("chat.debate.singleModelNotice")
      : !hasFullDebate
      ? args.t("chat.debate.incomplete")
      : args.t("chat.debate.completed", { count: args.participantCount }),
    ...(args.result.failures?.length
      ? ["", args.t("chat.debate.partialFailure", { count: args.result.failures.length })]
      : []),
    "",
    args.result.finalSolution,
    "",
    "<debate_process>",
    ...args.result.rounds.map((round, index) => [
      `### ${index + 1}. ${args.modelNameFor(round.modelId)} · ${round.role}`,
      round.content,
    ].join("\n")),
    ...(args.result.failures?.length
      ? [
          `### ${args.t("chat.debate.skippedFailuresTitle")}`,
          args.t("chat.debate.skippedFailuresBody", { count: args.result.failures.length }),
        ]
      : []),
    "</debate_process>",
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
