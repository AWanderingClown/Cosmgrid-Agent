// UsageEvent 写入器（v0.3：用 db.usageEvents 替代 Prisma）
import { usageEvents } from "../db";
import { calculateCost, type ChatUsage } from "./cost-calculator";

export interface RecordUsageParams {
  modelId: string;
  modelName: string;
  providerId: string;
  apiCredentialId: string;
  projectId?: string;
  conversationId?: string;
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
      await usageEvents.create({
        providerId: params.providerId,
        apiCredentialId: params.apiCredentialId,
        modelId: params.modelId,
        projectId: params.projectId ?? null,
        role: "main_chat",
        inputTokens: params.usage.inputTokens ?? 0,
        outputTokens: params.usage.outputTokens ?? 0,
        cacheCreationTokens: params.usage.cacheWriteInputTokens ?? 0,
        cacheHitTokens: params.usage.cacheReadInputTokens ?? 0,
        cost,
        success: params.finishReason === "stop",
        interrupted: params.interrupted ?? false,
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
