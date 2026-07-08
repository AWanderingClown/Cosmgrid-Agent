import {
  compressHistory,
  compressHistoryWithSummary,
  type ChatMsg,
} from "@/lib/llm/context-compressor";
import { resolveContextBudget } from "@/lib/llm/model-limits";
import { summarizeDroppedHistory, type HistorySummary } from "@/lib/llm/history-summarizer";
import type { LanguageModel } from "@/lib/llm/provider-factory";

export interface PromptCompressionResult {
  messages: ChatMsg[];
  compressionStats: { beforeTokens: number; afterTokens: number } | null;
}

/**
 * v0.9 同步版：纯抽取式裁剪。保留以保持外部调用点不变（在未启用摘要时仍走这条路）。
 */
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

/**
 * v0.9.1 摘要式压缩：每轮只在「确实超预算需要丢消息」时调用一次 LLM 摘要器。
 *
 * - 失败一律退回抽取式（summarize 抛错或返回 null 都自动降级）
 * - summarizeModel 不传 → 等价于 applyPromptCompression（保持兼容）
 * - 摘要文本插入位置与抽取式 notice 一致：在 systemMsgs 之后、kept 之前
 */
export async function applyPromptCompressionWithSummary(args: {
  enabled: boolean;
  messages: ChatMsg[];
  modelName: string;
  contextWindow: number | null;
  noticeText: (count: number) => string;
  /** 摘要用模型（必须便宜，绝不能用主对话模型；通常由 SmartRouter util 角色解析） */
  summarizeModel?: LanguageModel;
  /** 摘要生成前的前置诊断（test/diagnostics 用），默认 null */
  precheck?: (droppedCount: number) => boolean | Promise<boolean>;
}): Promise<PromptCompressionResult> {
  if (!args.enabled) {
    return { messages: args.messages, compressionStats: null };
  }

  const maxTokens = resolveContextBudget(args.modelName, args.contextWindow);

  // 没传摘要模型 → 走同步抽取式（向后兼容）
  if (!args.summarizeModel) {
    const compressed = compressHistory(args.messages, {
      maxTokens,
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

  // 摘要式：复用压缩器预算逻辑，丢的进摘要，没丢的不动
  // - summarizeModel 是闭包参数；HistorySummary → 文本序列化在闭包里完成
  const compressed = await compressHistoryWithSummary(args.messages, {
    maxTokens,
    noticeText: args.noticeText,
    summarize: async (dropped) => {
      // 前置诊断：例如 dropped < N 时不烧摘要（让早期小对话走纯抽取式）
      if (args.precheck) {
        const ok = await args.precheck(dropped.length);
        if (!ok) return null;
      }
      const summary = await summarizeDroppedHistory(dropped, args.summarizeModel!);
      return summary ? formatHistorySummary(summary, dropped.length) : null;
    },
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

/** 把 HistorySummary 结构化字段渲染成可塞进 system 消息的纯文本 */
function formatHistorySummary(summary: HistorySummary, _droppedCount: number): string {
  const lines: string[] = [];
  lines.push(`概览：${summary.summary}`);
  if (summary.keyDecisions.length > 0) {
    lines.push(`关键决策：\n${summary.keyDecisions.map((d) => `- ${d}`).join("\n")}`);
  }
  if (summary.factsEstablished.length > 0) {
    lines.push(`已确认事实：\n${summary.factsEstablished.map((f) => `- ${f}`).join("\n")}`);
  }
  if (summary.openThreads.length > 0) {
    lines.push(`待解决问题：\n${summary.openThreads.map((t) => `- ${t}`).join("\n")}`);
  }
  return lines.join("\n\n");
}