import { describe, expect, it } from "vitest";
import { budgetMeter, estimateCost, getBudgetWarning, mergeUsage } from "./budget";

describe("Tao budget accounting", () => {
  it("warns once at 50% and 80%, then halts at the limit", () => {
    expect(getBudgetWarning(4_999, 10_000)).toBeUndefined();
    expect(getBudgetWarning(5_000, 10_000)).toBe(50);
    expect(getBudgetWarning(8_000, 10_000)).toBe(80);
    expect(budgetMeter(10_000, 10_000)).toMatchObject({ halted: true, warning: 80 });
  });

  it("keeps cumulative usage monotonic and estimates token/tool cost", () => {
    const current = budgetMeter(5_000, 10_000);
    expect(mergeUsage(current, { inputTokens: 2_000, outputTokens: 4_000 })?.usedTokens).toBe(6_000);
    expect(mergeUsage(current, { inputTokens: 1_000, outputTokens: 1_000 })?.usedTokens).toBe(5_000);
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 500_000, searchCalls: 2, fetchCalls: 1 })).toBeCloseTo(6.015);
  });
});
