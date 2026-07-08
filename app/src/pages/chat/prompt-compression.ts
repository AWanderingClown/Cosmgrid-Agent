import {
  compressHistory,
  compressHistoryWithSummary,
  type ChatMsg,
} from "@/lib/llm/context-compressor";
import { resolveContextBudget } from "@/lib/llm/model-limits";
import { summarizeDroppedHistory, type HistorySummary } from "@/lib/llm/history-summarizer";
import type { LanguageModel } from "@/lib/llm/provider-factory";
import { conversationSummaries } from "@/lib/db";

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
export interface SummaryPersistence {
  /** 把摘要落库时使用——必填 */
  conversationId: string;
  /** 摘要生成用的模型 id（写库留痕，便于日后分析"哪个模型跑摘要最划算"） */
  modelId?: string | null;
  /** 摘要覆盖的原始消息估算 token 数（写库留痕） */
  tokenCount?: number | null;
}

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
  /** 摘要落库配置（不传 = 不落库，方便 test/diagnostics） */
  persistence?: SummaryPersistence;
}): Promise<PromptCompressionResult> {
  if (!args.enabled) {
    return { messages: args.messages, compressionStats: null };
  }

  const maxTokens = resolveContextBudget(args.modelName, args.contextWindow);

  // 没传摘要模型 → 走同步抽取式（向后兼容），直接复用旧实现
  if (!args.summarizeModel) {
    return applyPromptCompression({
      enabled: true,
      messages: args.messages,
      modelName: args.modelName,
      contextWindow: args.contextWindow,
      noticeText: args.noticeText,
    });
  }

  // 共享 holder：在 compressHistoryWithSummary 的 summarize 闭包里赋值，
  // 闭包结束后读出来落库。不能用裸 let——TS 在 await 之后会 narrow 失败（推断成 never）。
  const pendingSummaryHolder: { summary: HistorySummary | null } = { summary: null };

  // 局部 const 窄化 summarizeModel，让闭包内不用 `!` 非空断言
  const summarizeModel: LanguageModel = args.summarizeModel;

  // 摘要式：复用压缩器预算逻辑，丢的进摘要，没丢的不动
  // - HistorySummary → 文本序列化在闭包里完成
  const compressed = await compressHistoryWithSummary(args.messages, {
    maxTokens,
    noticeText: args.noticeText,
    summarize: async (dropped) => {
      // 前置诊断：例如 dropped < N 时不烧摘要（让早期小对话走纯抽取式）
      if (args.precheck) {
        const ok = await args.precheck(dropped.length);
        if (!ok) return null;
      }
      const summary = await summarizeDroppedHistory(dropped, summarizeModel);
      if (!summary) return null;
      // 把结构化摘要暂存到闭包外——compressHistoryWithSummary 不暴露中间状态，
      // 但我们要落库需要这个。Promise.all 不便；用一个共享 holder 是最简洁的写法。
      pendingSummaryHolder.summary = summary;
      return formatHistorySummary(summary);
    },
  });

  // 落库：fire-and-forget——失败绝不能阻断主对话发送流程
  // 用共享 holder 拿结构化摘要（不能用闭包内的 let 变量，TS 在 await 之后 narrow 失败）
  const summaryForPersistence = pendingSummaryHolder.summary;
  if (args.persistence && summaryForPersistence) {
    void conversationSummaries
      .create({
        conversationId: args.persistence.conversationId,
        summary: summaryForPersistence.summary,
        keyDecisions: summaryForPersistence.keyDecisions,
        factsEstablished: summaryForPersistence.factsEstablished,
        openThreads: summaryForPersistence.openThreads,
        modelId: args.persistence.modelId ?? null,
        tokenCount: args.persistence.tokenCount ?? null,
      })
      .catch((err) => {
        // 落库失败仅记录——不影响主流程；用户口径 §7 "上下文永不丢失"做不到
        // 但承诺"摘要文本已经在 system 消息里发给当前模型了"
        console.warn("[prompt-compression] 摘要落库失败，已忽略:", err);
      });
  }

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
function formatHistorySummary(summary: HistorySummary): string {
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
