import { describe, expect, it } from "vitest";
import { compactNativeCurve, type CurvePoint } from "./drawioMermaidCurves";

const midpoint = (a: CurvePoint, b: CurvePoint): CurvePoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function nativePath(points: CurvePoint[]): CurvePoint[] {
  const output: CurvePoint[] = [points[0]];
  let start = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const end = i === points.length - 2 ? points.at(-1)! : midpoint(points[i], points[i + 1]);
    for (let k = 1; k <= 40; k++) {
      const t = k / 40, u = 1 - t;
      output.push({ x: u * u * start.x + 2 * u * t * points[i].x + t * t * end.x,
        y: u * u * start.y + 2 * u * t * points[i].y + t * t * end.y });
    }
    start = end;
  }
  return output;
}
function shapeError(a: CurvePoint[], b: CurvePoint[]): number {
  const directional = (from: CurvePoint[], to: CurvePoint[]) => Math.max(...from.map(p => {
    let distance = Infinity;
    for (let i = 1; i < to.length; i++) {
      const start = to[i - 1], end = to[i], dx = end.x - start.x, dy = end.y - start.y;
      const t = Math.max(0, Math.min(1, ((p.x - start.x) * dx + (p.y - start.y) * dy) / (dx * dx + dy * dy || 1)));
      distance = Math.min(distance, Math.hypot(p.x - start.x - dx * t, p.y - start.y - dy * t));
    }
    return distance;
  }));
  return Math.max(directional(a, b), directional(b, a));
}

describe("native draw.io curved connectors", () => {
  it("uses one true control vertex for a quadratic arc, independent of dense SVG sampling", () => {
    const original = [{ x: 0, y: 0 }, { x: 180, y: -60 }, { x: 240, y: 120 }];
    const samples = nativePath(original);
    const curve = compactNativeCurve(samples);
    expect(curve).toHaveLength(3);
    expect(curve[0]).toEqual(original[0]); expect(curve.at(-1)).toEqual(original.at(-1));
    expect(shapeError(samples, nativePath(curve))).toBeLessThan(1.6);
  });

  it.each([
    ["S curve", [{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: -50, y: 160 }, { x: 100, y: 160 }]],
    ["self-call", [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 40 }, { x: 0, y: 40 }]],
    ["long return", [{ x: 120, y: 950 }, { x: 10, y: 950 }, { x: 10, y: 890 }, { x: 10, y: 60 }, { x: 10, y: 0 }, { x: 120, y: 0 }]],
  ] as const)("retains %s shape and exact endpoints with a small editable polygon", (_name, original) => {
    const samples = nativePath([...original]);
    const curve = compactNativeCurve(samples);
    expect(curve.length - 2).toBeLessThanOrEqual(8);
    expect(curve[0]).toEqual(original[0]); expect(curve.at(-1)).toEqual(original.at(-1));
    expect(shapeError(samples, nativePath(curve))).toBeLessThan(1.65);
  });

  it("retains closed curves and translated geometry without non-finite points", () => {
    const samples = nativePath([{ x: 10000, y: -2000 }, { x: 10100, y: -2020 }, { x: 10100, y: -1880 }, { x: 10000, y: -2000 }]);
    const curve = compactNativeCurve(samples);
    expect(curve.length - 2).toBeLessThanOrEqual(12);
    expect(curve.length).toBeGreaterThan(3);
    expect(curve.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(curve[0]).toEqual(curve.at(-1));
    expect(shapeError(samples, nativePath(curve))).toBeLessThan(1.65);
  });

  it("does not add curve handles to collinear or zero-length rendered paths", () => {
    expect(compactNativeCurve(Array.from({ length: 101 }, (_, x) => ({ x, y: 10 })))).toEqual([{ x: 0, y: 10 }, { x: 100, y: 10 }]);
    expect(compactNativeCurve(Array.from({ length: 20 }, () => ({ x: 3, y: 4 })))).toEqual([{ x: 3, y: 4 }, { x: 3, y: 4 }]);
    expect(compactNativeCurve([])).toEqual([]);
  });
});
