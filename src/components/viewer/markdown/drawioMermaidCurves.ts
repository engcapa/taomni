export interface CurvePoint { x: number; y: number }
const distance2 = (a: CurvePoint, b: CurvePoint) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const mix = (a: CurvePoint, b: CurvePoint, t: number): CurvePoint => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const MAX_CONTROLS = 12;

/** draw.io's native curved connector is a chain of quadratic Beziers. Its
 * waypoints are control vertices, not samples lying on the SVG curve. */
function weights(count: number, t: number): number[] {
  const segment = Math.min(count - 1, Math.floor(t * count));
  const u = Math.min(1, t * count - segment), v = 1 - u;
  const result = Array<number>(count + 2).fill(0);
  result[segment === 0 ? 0 : segment] += v * v * (segment === 0 ? 1 : 0.5);
  if (segment > 0) result[segment + 1] += v * v * 0.5;
  result[segment + 1] += 2 * v * u;
  result[segment === count - 1 ? count + 1 : segment + 1] += u * u * (segment === count - 1 ? 1 : 0.5);
  if (segment < count - 1) result[segment + 2] += u * u * 0.5;
  return result;
}

function evaluate(points: CurvePoint[], t: number): CurvePoint {
  const w = weights(points.length - 2, t);
  return points.reduce((p, q, index) => ({ x: p.x + q.x * w[index], y: p.y + q.y * w[index] }), { x: 0, y: 0 });
}

function fit(samples: CurvePoint[], parameters: number[], count: number): CurvePoint[] | null {
  const matrix = Array.from({ length: count }, () => Array<number>(count + 2).fill(0));
  for (let k = 1; k < samples.length - 1; k++) {
    const w = weights(count, parameters[k]);
    const residual = { x: samples[k].x - w[0] * samples[0].x - w[count + 1] * samples.at(-1)!.x,
      y: samples[k].y - w[0] * samples[0].y - w[count + 1] * samples.at(-1)!.y };
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) matrix[i][j] += w[i + 1] * w[j + 1];
      matrix[i][count] += w[i + 1] * residual.x;
      matrix[i][count + 1] += w[i + 1] * residual.y;
    }
  }
  // Small, pivoted least-squares solve; the endpoints remain fixed exactly.
  for (let i = 0; i < count; i++) {
    let pivot = i;
    for (let row = i + 1; row < count; row++) if (Math.abs(matrix[row][i]) > Math.abs(matrix[pivot][i])) pivot = row;
    [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
    if (Math.abs(matrix[i][i]) < 1e-9) return null;
    const divisor = matrix[i][i];
    for (let col = i; col < count + 2; col++) matrix[i][col] /= divisor;
    for (let row = 0; row < count; row++) {
      if (row === i) continue;
      const factor = matrix[row][i];
      for (let col = i; col < count + 2; col++) matrix[row][col] -= factor * matrix[i][col];
    }
  }
  const points = [samples[0], ...matrix.map(row => ({ x: row[count], y: row[count + 1] })), samples.at(-1)!];
  return points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) ? points : null;
}

function closest(point: CurvePoint, polyline: CurvePoint[], minT = 0): { error: number; t: number } {
  let error = Infinity, t = minT;
  for (let i = Math.floor(minT * (polyline.length - 1)); i < polyline.length - 1; i++) {
    const a = polyline[i], b = polyline[i + 1], length2 = distance2(a, b);
    const u = Math.max(0, Math.min(1, length2 ? ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length2 : 0));
    const nextT = (i + u) / (polyline.length - 1);
    if (nextT < minT) continue;
    const nextError = distance2(point, mix(a, b, u));
    if (nextError < error) { error = nextError; t = nextT; }
  }
  return { error, t };
}

function parameters(samples: CurvePoint[], lengths: number[], power: number): number[] {
  if (power === 1) return lengths.map(value => value / (lengths.at(-1) || 1));
  // A second parameterization gives bends more weight than a long straight
  // leg. This avoids filling that leg with unnecessary editable handles.
  const keep = new Set([0, samples.length - 1]);
  const pending = [[0, samples.length - 1]];
  while (pending.length) {
    const [a, b] = pending.pop()!;
    let maximum = 16, index = -1;
    for (let i = a + 1; i < b; i++) {
      const error = closest(samples[i], [samples[a], samples[b]]).error;
      if (error > maximum) { maximum = error; index = i; }
    }
    if (index >= 0) { keep.add(index); pending.push([a, index], [index, b]); }
  }
  const knots = [...keep].sort((a, b) => a - b), cumulative = [0];
  for (let i = 1; i < knots.length; i++) cumulative.push(cumulative.at(-1)! + Math.pow(lengths[knots[i]] - lengths[knots[i - 1]], power));
  let knot = 1;
  return samples.map((_, i) => {
    while (knot < knots.length - 1 && knots[knot] < i) knot++;
    const a = knots[knot - 1], b = knots[knot];
    const ratio = (lengths[i] - lengths[a]) / (lengths[b] - lengths[a] || 1);
    return (cumulative[knot - 1] + (cumulative[knot] - cumulative[knot - 1]) * ratio) / (cumulative.at(-1) || 1);
  });
}

/** Samples only measure shape. Export the smallest native control polygon
 * meeting the visual tolerance, bounded independently of SVG path length. */
export function compactNativeCurve(samples: CurvePoint[], tolerance = 1.5): CurvePoint[] {
  if (samples.length < 3) return samples;
  if (samples.every(p => closest(p, [samples[0], samples.at(-1)!]).error < 0.0025)) return [samples[0], samples.at(-1)!];
  const lengths = [0];
  for (let i = 1; i < samples.length; i++) lengths.push(lengths.at(-1)! + Math.sqrt(distance2(samples[i - 1], samples[i])));
  const seeds = [1, 0.7].map(power => parameters(samples, lengths, power));
  const uniform = samples.map((_, index) => index / (samples.length - 1));
  // Callers may supply Bezier-parameter samples rather than arc-length
  // samples. Retain that seed when it differs; a native curve can then be
  // recovered exactly without inventing controls along its long straight leg.
  if (uniform.some((value, index) => Math.abs(value - seeds[0][index]) > 0.01)) seeds.unshift(uniform);
  let best = [samples[0], samples[Math.floor(samples.length / 2)], samples.at(-1)!], bestError = Infinity;
  for (let count = 1; count <= MAX_CONTROLS; count++) {
    for (const seed of seeds) {
      let current = seed;
      for (let iteration = 0; iteration < 12; iteration++) {
        const points = fit(samples, current, count);
        if (!points) break;
        const rendered = Array.from({ length: count * 32 + 1 }, (_, i) => evaluate(points, i / (count * 32)));
        let error = 0, previousT = 0;
        const next = samples.map((point, i) => {
          if (i === 0) return 0;
          if (i === samples.length - 1) return 1;
          const projection = closest(point, rendered, previousT);
          previousT = projection.t;
          error = Math.max(error, projection.error);
          return projection.t;
        });
        for (const point of rendered) error = Math.max(error, closest(point, samples).error);
        if (error < bestError) { bestError = error; best = points; }
        if (error <= tolerance * tolerance) return points;
        current = next;
      }
    }
  }
  return best;
}
