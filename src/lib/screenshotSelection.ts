import type { ScreenshotPoint, ScreenshotRect } from "./screenshot";

export function contourBounds(points: readonly ScreenshotPoint[]): ScreenshotRect | null {
  if (points.length === 0 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Even-odd containment, including the boundary, shared by selection and tools. */
export function pointInContour(point: ScreenshotPoint, points: readonly ScreenshotPoint[]): boolean {
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-7 && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x)
      && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) return true;
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y)) inside = !inside;
  }
  return inside;
}

/** Reject clicks, straight lines and retraced contours, including large diagonals. */
export function validContour(points: readonly ScreenshotPoint[], minimum = 6): boolean {
  const bounds = contourBounds(points);
  if (!bounds || points.length < 3 || bounds.w < minimum || bounds.h < minimum) return false;
  // OS/browser integer coordinates give diagonal lines a subpixel staircase.
  // Its accumulated area can be large; require meaningful departure from the
  // longest axis as well, without simplifying a valid user's contour.
  const origin = points[0];
  const axis = points.reduce((far, p) => Math.hypot(p.x - origin.x, p.y - origin.y)
    > Math.hypot(far.x - origin.x, far.y - origin.y) ? p : far, origin);
  const dx = axis.x - origin.x, dy = axis.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (!points.some((p) => Math.abs((p.x - origin.x) * dy - (p.y - origin.y) * dx) / length >= minimum / 2)) return false;
  // Bounded scanline integration also admits self-intersecting even-odd contours.
  const rows = 64;
  let area = 0;
  for (let row = 0; row < rows; row++) {
    const y = bounds.y + bounds.h * (row + 0.5) / rows;
    const xs: number[] = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j], b = points[i];
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) area += (xs[i + 1] - xs[i]) * bounds.h / rows;
  }
  return area >= minimum * minimum;
}

export function transformContour(
  points: readonly ScreenshotPoint[], from: ScreenshotRect, to: ScreenshotRect,
): ScreenshotPoint[] {
  return points.map((p) => ({
    x: to.x + (p.x - from.x) * to.w / Math.max(from.w, 1e-9),
    y: to.y + (p.y - from.y) * to.h / Math.max(from.h, 1e-9),
  }));
}

export function contourPath(points: readonly ScreenshotPoint[], closed = true): string {
  return points.length ? `M ${points.map((p) => `${p.x} ${p.y}`).join(" L ")}${closed ? " Z" : ""}` : "";
}

export function traceContour(ctx: CanvasRenderingContext2D, points: readonly ScreenshotPoint[]): void {
  ctx.beginPath();
  points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
}

/** Apply the mask last, after watermarking, so no output action leaks exterior pixels. */
export function maskContour(
  ctx: CanvasRenderingContext2D, points: readonly ScreenshotPoint[],
  sx: number, sy: number, crop: { x: number; y: number },
): void {
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  traceContour(ctx, points.map((p) => ({ x: p.x * sx - crop.x, y: p.y * sy - crop.y })));
  ctx.fillStyle = "#ffffff";
  ctx.fill("evenodd");
  ctx.restore();
}
