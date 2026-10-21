

export const MIN_SPLIT_WEIGHT = 0.35;


export function positiveWeight(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 1;
}


export function axisWeights(weights: number[], count: number): number[] {
  return Array.from({ length: count }, (_, index) => positiveWeight(weights[index]));
}


export function sumWeights(weights: number[]): number {
  return weights.reduce((sum, weight) => sum + positiveWeight(weight), 0) || 1;
}


export function resizeAdjacentWeights(weights: number[], index: number, deltaWeight: number): number[] {
  const next = weights.map(positiveWeight);
  if (index < 0 || index >= next.length - 1) return next;

  const left = next[index];
  const right = next[index + 1];
  const minDelta = MIN_SPLIT_WEIGHT - left;
  const maxDelta = right - MIN_SPLIT_WEIGHT;
  const clampedDelta = Math.max(minDelta, Math.min(maxDelta, deltaWeight));
  next[index] = left + clampedDelta;
  next[index + 1] = right - clampedDelta;
  return next;
}


export function weightsToGridTemplate(weights: number[]): string {
  return weights.map((weight) => `minmax(0, ${positiveWeight(weight)}fr)`).join(" ");
}


export function cumulativeWeightPercent(weights: number[], index: number): number {
  const total = sumWeights(weights);
  const before = weights
    .slice(0, index + 1)
    .reduce((sum, weight) => sum + positiveWeight(weight), 0);
  return total > 0 ? (before / total) * 100 : 0;
}
