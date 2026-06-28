import type { ChatUsage } from "./cost-calculator";
import type { ResolvedModelPrice } from "./price-catalog";

export interface SavingsCalculation {
  baselineCost: number;
  actualCost: number;
  savedCost: number;
  explain: Record<string, unknown>;
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function calculateCacheSavings(args: {
  usage: ChatUsage;
  actualCost: number;
  resolvedPrice: ResolvedModelPrice;
}): SavingsCalculation | null {
  const cacheHitTokens = args.usage.cacheReadInputTokens ?? 0;
  if (cacheHitTokens <= 0) return null;
  if (args.resolvedPrice.cacheRead === undefined) return null;

  const saved = (cacheHitTokens / 1_000_000) * (args.resolvedPrice.input - args.resolvedPrice.cacheRead);
  if (saved <= 0) return null;

  return {
    baselineCost: roundUsd(args.actualCost + saved),
    actualCost: roundUsd(args.actualCost),
    savedCost: roundUsd(saved),
    explain: {
      cacheHitTokens,
      inputPricePer1m: args.resolvedPrice.input,
      cacheReadPricePer1m: args.resolvedPrice.cacheRead,
    },
  };
}

export function calculateRoutingSavings(args: {
  baselineCost: number;
  actualCost: number;
  baselineModelId: string;
  actualModelId: string;
}): SavingsCalculation | null {
  const saved = args.baselineCost - args.actualCost;
  if (saved <= 0) return null;
  return {
    baselineCost: roundUsd(args.baselineCost),
    actualCost: roundUsd(args.actualCost),
    savedCost: roundUsd(saved),
    explain: {
      baselineModelId: args.baselineModelId,
      actualModelId: args.actualModelId,
    },
  };
}

export function calculateCompressionSavings(args: {
  beforeTokens: number;
  afterTokens: number;
  inputPricePer1m: number;
}): SavingsCalculation | null {
  if (args.beforeTokens <= args.afterTokens) return null;
  const baseline = (args.beforeTokens / 1_000_000) * args.inputPricePer1m;
  const actual = (args.afterTokens / 1_000_000) * args.inputPricePer1m;
  const saved = baseline - actual;
  if (saved <= 0) return null;
  return {
    baselineCost: roundUsd(baseline),
    actualCost: roundUsd(actual),
    savedCost: roundUsd(saved),
    explain: {
      beforeTokens: args.beforeTokens,
      afterTokens: args.afterTokens,
      inputPricePer1m: args.inputPricePer1m,
    },
  };
}
