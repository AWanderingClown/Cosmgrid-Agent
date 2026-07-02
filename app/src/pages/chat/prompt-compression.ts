import { compressHistory, type ChatMsg } from "@/lib/llm/context-compressor";
import { resolveContextBudget } from "@/lib/llm/model-limits";

export interface PromptCompressionResult {
  messages: ChatMsg[];
  compressionStats: { beforeTokens: number; afterTokens: number } | null;
}

export function applyPromptCompression(args: {
  enabled: boolean;
  messages: ChatMsg[];
  modelName: string;
  contextWindow: number | null;
  noticeText: (count: number) => string;
}): PromptCompressionResult {
  if (!args.enabled) {
    return { messages: args.messages, compressionStats: null };
  }

  const compressed = compressHistory(args.messages, {
    maxTokens: resolveContextBudget(args.modelName, args.contextWindow),
    noticeText: args.noticeText,
  });

  return {
    messages: compressed.messages,
    compressionStats: compressed.compressed
      ? {
          beforeTokens: compressed.beforeTokens,
          afterTokens: compressed.afterTokens,
        }
      : null,
  };
}
