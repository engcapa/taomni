import { pointInContour } from "../../../lib/screenshotSelection";
import { type CssRect, type Point, type Shape, type TextShape } from "./types";

export const TEXT_FONT_SIZE = 18;

export const FONT_STACK = 'Inter, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

export const TEXT_LINE_HEIGHT = 1.2;

/** Measure each explicit line with the same font used for live and exported text. */
export function textBounds(shape: TextShape): CssRect {
  const lines = shape.text.split("\n");
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx) ctx.font = `600 ${shape.fontSize}px ${shape.fontFamily ?? FONT_STACK}`;
  const widths = lines.map((line) => ctx?.measureText(line)?.width ?? line.length * shape.fontSize);
  return { x: shape.x, y: shape.y, w: Math.max(shape.fontSize, ...widths), h: lines.length * shape.fontSize * TEXT_LINE_HEIGHT };
}

export function inRect(p: Point, r: CssRect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normRect(r: { x: number; y: number; w: number; h: number; }): CssRect {
  return {
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

export function rectFromDrag(a: Point, b: Point): CssRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Shortest distance from `p` to a polyline (a lone point is a dot). */
export function distToPath(p: Point, pts: readonly Point[]): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return dist(p, pts[0]);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  return best;
}

/** Points along a polyline no further than `step` apart (endpoints kept). */
export function resamplePath(pts: readonly Point[], step: number): Point[] {
  if (pts.length < 2) return [...pts];
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
  }
  return out;
}

/** Whether `p` is within `radius` of a shape's geometry (eraser). */
export function shapeHitTest(shape: Shape, p: Point, radius: number): boolean {
  if (shape.kind === "pen" && shape.filled && shape.pts.length >= 3 && pointInContour(p, shape.pts)) return true;
  switch (shape.kind) {
    case "rect":
    case "ellipse":
    case "mosaic":
    case "blur":
    case "balloon": {
      const r = normRect(shape);
      return p.x >= r.x - radius && p.x <= r.x + r.w + radius && p.y >= r.y - radius && p.y <= r.y + r.h + radius;
    }
    case "line":
    case "arrow": {
      const dx = shape.x2 - shape.x1;
      const dy = shape.y2 - shape.y1;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return Math.hypot(p.x - shape.x1, p.y - shape.y1) <= radius;
      const t = Math.max(0, Math.min(1, ((p.x - shape.x1) * dx + (p.y - shape.y1) * dy) / lenSq));
      return Math.hypot(p.x - (shape.x1 + t * dx), p.y - (shape.y1 + t * dy)) <= radius;
    }
    case "pen":
    case "highlighter":
      return shape.pts.some((pt, i) => i === 0
        ? dist(pt, p) <= radius + shape.lineWidth
        : shapeHitTest({ ...shape, kind: "line", x1: shape.pts[i - 1].x, y1: shape.pts[i - 1].y, x2: pt.x, y2: pt.y }, p, radius + shape.lineWidth));
    case "text": {
      const r = textBounds(shape);
      return p.x >= r.x - radius && p.x <= r.x + r.w + radius
        && p.y >= r.y - radius && p.y <= r.y + r.h + radius;
    }
    case "number":
      return Math.hypot(shape.x - p.x, shape.y - p.y) <= radius + 14;
  }
}

export function shapeBounds(shape: Shape): CssRect {
  switch (shape.kind) {
    case "rect": case "ellipse": case "mosaic": case "blur": return normRect(shape);
    case "balloon": {
      const r = normRect(shape);
      return rectFromDrag({ x: Math.min(r.x, shape.tx), y: Math.min(r.y, shape.ty) },
        { x: Math.max(r.x + r.w, shape.tx), y: Math.max(r.y + r.h, shape.ty) });
    }
    case "line": case "arrow": return rectFromDrag({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 });
    case "pen": case "highlighter": {
      const xs = shape.pts.map((p) => p.x), ys = shape.pts.map((p) => p.y);
      return rectFromDrag({ x: Math.min(...xs), y: Math.min(...ys) }, { x: Math.max(...xs), y: Math.max(...ys) });
    }
    case "text": return textBounds(shape);
    case "number": {
      const r = Math.max(14, shape.lineWidth * 4);
      return { x: shape.x - r, y: shape.y - r, w: r * 2, h: r * 2 };
    }
  }
}

/** Transform all geometry together, keeping the stored snapshot immutable. */
export function transformShape(shape: Shape, from: CssRect, to: CssRect): Shape {
  const sx = from.w ? to.w / from.w : 1, sy = from.h ? to.h / from.h : 1;
  const x = (v: number) => to.x + (v - from.x) * sx;
  const y = (v: number) => to.y + (v - from.y) * sy;
  const moved = transformGeometry(shape, x, y, sx, sy);
  if (!shape.erase) return moved;
  const k = Math.sqrt(Math.abs(sx * sy)) || 1;
  return { ...moved, erase: shape.erase.map((s) => ({ width: s.width * k, pts: s.pts.map((p) => ({ x: x(p.x), y: y(p.y) })) })) };
}

export function transformGeometry(shape: Shape, x: (v: number) => number, y: (v: number) => number, sx: number, sy: number): Shape {
  switch (shape.kind) {
    case "rect": case "ellipse": case "mosaic": case "blur":
      return {
        ...shape,
        x: x(shape.x),
        y: y(shape.y),
        w: shape.w * sx,
        h: shape.h * sy,
      };
    case "balloon": return {
      ...shape,
      x: x(shape.x),
      y: y(shape.y),
      w: shape.w * sx,
      h: shape.h * sy,
      tx: x(shape.tx),
      ty: y(shape.ty),
    };
    case "line": case "arrow": return {
      ...shape,
      x1: x(shape.x1),
      y1: y(shape.y1),
      x2: x(shape.x2),
      y2: y(shape.y2),
    };
    case "pen": case "highlighter": return { ...shape, pts: shape.pts.map((p) => ({ x: x(p.x), y: y(p.y) })) };
    case "text": return { ...shape, x: x(shape.x), y: y(shape.y), fontSize: Math.max(8, shape.fontSize * sy) };
    case "number": return { ...shape, x: x(shape.x), y: y(shape.y), lineWidth: Math.max(1, shape.lineWidth * Math.min(sx, sy)) };
  }
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
