import type { TaoBudget, TaoUsage } from "./ai-chat/ports";

export interface PricingTable {
  asOf: string;
  inputPerMillionCny: number;
  outputPerMillionCny: number;
  searchPerCallCny: number;
  fetchPerCallCny: number;
}

export const DEFAULT_PRICING: PricingTable = {
  asOf: "2026-11-14",
  inputPerMillionCny: 2,
  outputPerMillionCny: 8,
  searchPerCallCny: 0.005,
  fetchPerCallCny: 0.005,
};

export function estimateCost(usage: TaoUsage, pricing: PricingTable = DEFAULT_PRICING): number {
  return usage.inputTokens / 1_000_000 * pricing.inputPerMillionCny
    + usage.outputTokens / 1_000_000 * pricing.outputPerMillionCny
    + usage.searchCalls * pricing.searchPerCallCny
    + usage.fetchCalls * pricing.fetchPerCallCny;
}

export function getBudgetWarning(usedTokens: number, limitTokens: number): TaoBudget["warning"] {
  if (limitTokens <= 0) return undefined;
  const ratio = usedTokens / limitTokens;
  if (ratio >= 0.8) return 80;
  if (ratio >= 0.5) return 50;
  return undefined;
}

export function budgetMeter(usedTokens: number, limitTokens = 10_000_000): TaoBudget {
  return { usedTokens, limitTokens, warning: getBudgetWarning(usedTokens, limitTokens), halted: usedTokens >= limitTokens };
}

export function mergeUsage(budget: TaoBudget | undefined, usage?: Partial<TaoUsage>): TaoBudget | undefined {
  if (!budget || !usage) return budget;
  const usedTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (usedTokens === 0 && budget.usedTokens === 0) return budget;
  const next = Math.max(budget.usedTokens, usedTokens);
  return { ...budget, usedTokens: next, warning: getBudgetWarning(next, budget.limitTokens), halted: next >= budget.limitTokens };
}
