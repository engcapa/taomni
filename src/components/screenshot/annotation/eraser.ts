import { dist, distToPath, normRect, resamplePath, shapeHitTest } from "./geometry";
import { type Point, type Shape } from "./types";

/** Half the painted width of a stroke-like shape. */
export function strokeHalfWidth(shape: Shape): number {
  return shape.kind === "highlighter" ? Math.max(8, shape.lineWidth * 3) / 2 : Math.max(1, shape.lineWidth) / 2;
}

/** Centre line of shapes whose pixels are fully described by a stroke. */
export function strokePath(shape: Shape): Point[] | null {
  if ((shape.kind === "pen" && !shape.filled) || shape.kind === "highlighter") return shape.pts;
  if (shape.kind === "line") return [{ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }];
  return null;
}

/** Whether every painted pixel of a stroke lies under its erase masks. */
export function fullyErased(shape: Shape): boolean {
  const path = strokePath(shape);
  if (!path || !shape.erase?.length) return false;
  const half = strokeHalfWidth(shape);
  return resamplePath(path, Math.max(0.5, half / 2))
    .every((p) => shape.erase!.some((s) => distToPath(p, s.pts) + half <= s.width / 2));
}

/** Whether the eraser at `p` touches visible pixels of `shape`. */
export function eraseHitTest(shape: Shape, p: Point, radius: number): boolean {
  if (shape.erase?.some((s) => distToPath(p, s.pts) + radius <= s.width / 2)) return false;
  if ((shape.kind === "rect" || shape.kind === "ellipse") && !shape.filled) {
    // Outlines have no interior pixels to erase.
    const r = normRect(shape);
    const reach = radius + shape.lineWidth / 2;
    if (shape.kind === "rect") {
      const corners = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
      return distToPath(p, [...corners, corners[0]]) <= reach;
    }
    const a = Math.max(0.5, r.w / 2), b = Math.max(0.5, r.h / 2);
    const cx = r.x + a, cy = r.y + b;
    const t = Math.atan2((p.y - cy) / b, (p.x - cx) / a);
    return dist(p, { x: cx + a * Math.cos(t), y: cy + b * Math.sin(t) }) <= reach;
  }
  return shapeHitTest(shape, p, radius);
}

/**
 * Partial eraser: removes exactly the pixels under the eraser path from every
 * shape it touches, like a raster eraser, while each shape stays editable
 * (the mask moves and scales with it). A stroke whose every painted pixel has
 * been erased is dropped. Returns the input array when nothing changed.
 */
export function eraseShapes(shapes: readonly Shape[], eraser: readonly Point[], radius: number): readonly Shape[] {
  const path = resamplePath(eraser, Math.max(1, radius / 2));
  let changed = false;
  const out: Shape[] = [];
  for (const shape of shapes) {
    if (!path.some((p) => eraseHitTest(shape, p, radius))) {
      out.push(shape);
      continue;
    }
    changed = true;
    const next = { ...shape, erase: [...(shape.erase ?? []), { pts: path, width: radius * 2 }] };
    if (!fullyErased(next)) out.push(next);
  }
  return changed ? out : shapes;
}

/** Eraser reach (CSS px) for the selected line width: 2/4/8 -> 6/8/16. */
export function eraserRadius(lineWidth: number): number {
  return Math.max(6, lineWidth * 2);
}
