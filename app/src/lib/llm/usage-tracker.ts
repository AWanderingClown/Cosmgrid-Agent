// UsageEvent 写入器（v0.3：用 db.usageEvents 替代 Prisma）
import { savingsEvents, usageEvents } from "../db";
import { estimateCostWithCatalog, type ChatUsage } from "./cost-calculator";
import { isNormalFinishReason } from "./finish-reason";
import { recordPerformanceSample } from "./model-performance-stats";
import {
  calculateCacheSavings,
  calculateCompressionSavings,
  calculateRoutingSavings,
} from "./savings-calculator";

export interface RecordUsageParams {
  modelId: string;
  modelName: string;
  providerType?: string | null;
  providerId: string;
  apiCredentialId: string;
  projectId?: string;
  conversationId?: string;
  /** 消息难度桶（simple/standard/hard），供 v0.9 SmartRouter 按 taskType 滚动统计。
   *  不传时兜底 "main_chat"（向后兼容旧调用方） */
  role?: string;
  /** 阶段 F1：actor 维度（哪个角色跑的 = leader/architect/frontend/.../stage）。
   *  - 跟 role（workRole 难度桶）配对清晰，不撞名
   *  - 不传 → NULL（review F1-1：leader 占比 80%+，NULL 是真实数据，聚合不过滤 NULL）
   *  - 类型约束由调用方保障（chat-fallback 接收 RoleId | 'stage' | null） */
  roleKind?: string | null;
  /** 本次调用耗时（ms），用于 ModelPerformanceStat 的 avgLatencyMs；不传按 0 计 */
  latencyMs?: number;
  usage: ChatUsage;
  finishReason: string;
  interrupted?: boolean;
  routingDecision?: {
    baselineModelId: string;
    baselineModelName: string;
    baselineProviderType?: string | null;
    actualModelId: string;
  } | null;
  compressionStats?: {
    beforeTokens: number;
    afterTokens: number;
  } | null;
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
      const costEstimate = await estimateCostWithCatalog(params.modelName, params.usage, params.providerType ?? null);
      const role = params.role ?? "main_chat";
      const success = isNormalFinishReason(params.finishReason);
      const usageEventId = await usageEvents.create({
        providerId: params.providerId,
        apiCredentialId: params.apiCredentialId,
        modelId: params.modelId,
        projectId: params.projectId ?? null,
        conversationId: params.conversationId ?? null,
        role,
        // 阶段 F1：role_kind 透传（不传 → NULL；review F1-1 不过滤 NULL）
        ...(params.roleKind !== undefined ? { roleKind: params.roleKind } : {}),
        inputTokens: params.usage.inputTokens ?? 0,
        outputTokens: params.usage.outputTokens ?? 0,
        cacheCreationTokens: params.usage.cacheWriteInputTokens ?? 0,
        cacheHitTokens: params.usage.cacheReadInputTokens ?? 0,
        cost: costEstimate.cost,
        pricingKnown: costEstimate.pricingKnown,
        priceVersion: costEstimate.priceVersion,
        priceSource: costEstimate.priceSource,
        priceCatalogId: costEstimate.priceCatalogId,
        success,
        interrupted: params.interrupted ?? false,
      });

      if (success && costEstimate.pricingKnown && costEstimate.resolvedPrice) {
        const cacheSavings = calculateCacheSavings({
          usage: params.usage,
          actualCost: costEstimate.cost,
          resolvedPrice: costEstimate.resolvedPrice,
        });
        if (cacheSavings) {
          await savingsEvents.create({
            usageEventId,
            conversationId: params.conversationId ?? null,
            projectId: params.projectId ?? null,
            kind: "cache",
            actualModelId: params.modelId,
            baselineModelId: params.modelId,
            baselineCost: cacheSavings.baselineCost,
            actualCost: cacheSavings.actualCost,
            savedCost: cacheSavings.savedCost,
            formulaVersion: "cache-v1",
            actualPriceCatalogId: costEstimate.priceCatalogId,
            baselinePriceCatalogId: costEstimate.priceCatalogId,
            explainJson: JSON.stringify({
              ...cacheSavings.explain,
              priceVersion: costEstimate.priceVersion,
              priceSource: costEstimate.priceSource,
            }),
          });
        }

        if (
          params.routingDecision &&
          params.routingDecision.actualModelId === params.modelId
        ) {
          const baselineEstimate = await estimateCostWithCatalog(
            params.routingDecision.baselineModelName,
            params.usage,
            params.routingDecision.baselineProviderType ?? null,
          );
          if (baselineEstimate.pricingKnown) {
            const routingSavings = calculateRoutingSavings({
              baselineCost: baselineEstimate.cost,
              actualCost: costEstimate.cost,
              baselineModelId: params.routingDecision.baselineModelId,
              actualModelId: params.modelId,
            });
            if (routingSavings) {
              await savingsEvents.create({
                usageEventId,
                conversationId: params.conversationId ?? null,
                projectId: params.projectId ?? null,
                kind: "routing",
                actualModelId: params.modelId,
                baselineModelId: params.routingDecision.baselineModelId,
                baselineCost: routingSavings.baselineCost,
                actualCost: routingSavings.actualCost,
                savedCost: routingSavings.savedCost,
                formulaVersion: "routing-v1",
                actualPriceCatalogId: costEstimate.priceCatalogId,
                baselinePriceCatalogId: baselineEstimate.priceCatalogId,
                explainJson: JSON.stringify({
                  ...routingSavings.explain,
                  actualPriceVersion: costEstimate.priceVersion,
                  baselinePriceVersion: baselineEstimate.priceVersion,
                }),
              });
            }
          }
        }

        if (params.compressionStats) {
          const compressionSavings = calculateCompressionSavings({
            beforeTokens: params.compressionStats.beforeTokens,
            afterTokens: params.compressionStats.afterTokens,
            inputPricePer1m: costEstimate.resolvedPrice.input,
          });
          if (compressionSavings) {
            await savingsEvents.create({
              usageEventId,
              conversationId: params.conversationId ?? null,
              projectId: params.projectId ?? null,
              kind: "compression",
              actualModelId: params.modelId,
              baselineModelId: params.modelId,
              baselineCost: compressionSavings.baselineCost,
              actualCost: compressionSavings.actualCost,
              savedCost: compressionSavings.savedCost,
              formulaVersion: "compression-v1",
              actualPriceCatalogId: costEstimate.priceCatalogId,
              baselinePriceCatalogId: costEstimate.priceCatalogId,
              explainJson: JSON.stringify({
                ...compressionSavings.explain,
                priceVersion: costEstimate.priceVersion,
              }),
            });
          }
        }
      }

      // v0.9 阶段7：同一份样本喂给模型表现滚动统计（旁路，内部自吞错）
      await recordPerformanceSample(params.modelId, role, {
        inputTokens: params.usage.inputTokens ?? 0,
        outputTokens: params.usage.outputTokens ?? 0,
        cost: costEstimate.cost,
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
