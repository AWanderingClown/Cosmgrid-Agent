// UsageEvent 写入器（v0.3：用 db.usageEvents 替代 Prisma）
import { usageEvents } from "../db";
import { calculateCost, type ChatUsage } from "./cost-calculator";
import { recordPerformanceSample } from "./model-performance-stats";

export interface RecordUsageParams {
  modelId: string;
  modelName: string;
  providerId: string;
  apiCredentialId: string;
  projectId?: string;
  conversationId?: string;
  /** 消息难度桶（simple/standard/hard），供 v0.9 SmartRouter 按 taskType 滚动统计。
   *  不传时兜底 "main_chat"（向后兼容旧调用方） */
  role?: string;
  /** 本次调用耗时（ms），用于 ModelPerformanceStat 的 avgLatencyMs；不传按 0 计 */
  latencyMs?: number;
  usage: ChatUsage;
  finishReason: string;
  interrupted?: boolean;
}

const pendingWrites = new Set<Promise<void>>();

export async function flushPendingWrites(): Promise<void> {
  if (pendingWrites.size === 0) return;
  await Promise.allSettled(Array.from(pendingWrites));
}

export function recordUsageEvent(
  params: RecordUsageParams,
  options: { awaitWrite?: boolean } = {},
): Promise<void> | void {
  const writePromise = (async () => {
    try {
      const cost = calculateCost(params.modelName, params.usage);
      const role = params.role ?? "main_chat";
      const success = params.finishReason === "stop";
      await usageEvents.create({
        providerId: params.providerId,
        apiCredentialId: params.apiCredentialId,
        modelId: params.modelId,
        projectId: params.projectId ?? null,
        role,
        inputTokens: params.usage.inputTokens ?? 0,
        outputTokens: params.usage.outputTokens ?? 0,
        cacheCreationTokens: params.usage.cacheWriteInputTokens ?? 0,
        cacheHitTokens: params.usage.cacheReadInputTokens ?? 0,
        cost,
        success,
        interrupted: params.interrupted ?? false,
      });
      // v0.9 阶段7：同一份样本喂给模型表现滚动统计（旁路，内部自吞错）
      await recordPerformanceSample(params.modelId, role, {
        inputTokens: params.usage.inputTokens ?? 0,
        outputTokens: params.usage.outputTokens ?? 0,
        cost,
        ...(params.latencyMs !== undefined ? { latencyMs: params.latencyMs } : {}),
        success,
      });
    } catch (error) {
      console.error("[usage-tracker] 写入 UsageEvent 失败:", error);
    }
  })();

  pendingWrites.add(writePromise);
  void writePromise.finally(() => pendingWrites.delete(writePromise));

  if (options.awaitWrite) {
    return writePromise;
  }
}
