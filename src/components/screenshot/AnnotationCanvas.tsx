import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { pointInContour, traceContour } from "../../lib/screenshotSelection";
import type { ScreenshotPoint } from "../../lib/screenshot";

export type AnnotationTool =
  | "select"
  | "move"
  | "rect"
  | "ellipse"
  | "arrow"
  | "line"
  | "pen"
  | "highlighter"
  | "text"
  | "mosaic"
  | "blur"
  | "number"
  | "balloon"
  | "eraser";

export interface CssRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

/** A partial-eraser pass attached to the shape it removed pixels from. */
export interface EraseStroke {
  pts: Point[];
  /** Stroke diameter in canvas CSS px. */
  width: number;
}

interface ShapeBase {
  id: number;
  color: string;
  lineWidth: number;
  /**
   * Partial erasures. Stored on the shape (not the layer) so moving or
   * resizing the shape keeps exactly the same pixels removed.
   */
  erase?: EraseStroke[];
}

export interface RectLikeShape extends ShapeBase {
  kind: "rect" | "ellipse" | "mosaic" | "blur";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Solid rect / ellipse instead of an outline. */
  filled?: boolean;
}

export interface LineLikeShape extends ShapeBase {
  kind: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PenShape extends ShapeBase {
  kind: "pen" | "highlighter";
  pts: Point[];
  /** Freehand pen closed into a solid region. */
  filled?: boolean;
}

export type EraserMode = "partial" | "object";

/** Tools whose shapes can be drawn solid. */
export const FILLABLE_TOOLS: readonly AnnotationTool[] = ["rect", "ellipse", "pen"];

export interface TextShape extends ShapeBase {
  kind: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontFamily?: string;
}

export interface NumberShape extends ShapeBase {
  kind: "number";
  x: number;
  y: number;
  num: number;
}

export interface BalloonShape extends ShapeBase {
  kind: "balloon";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Tail tip position (points to the annotated target). */
  tx: number;
  ty: number;
}

export type Shape = RectLikeShape | LineLikeShape | PenShape | TextShape | NumberShape | BalloonShape;

export interface AnnotationCanvasHandle {
  undo: () => void;
  redo: () => void;
  clear: () => void;
  /**
   * Composite the base image and all shapes at the image's natural size.
   * `sx`/`sy` map canvas CSS px to natural px per axis.
   */
  exportDataUrl: (base: HTMLImageElement, sx: number, sy: number) => string;
  /** Programmatically add shapes (e.g. auto-redact boxes) as one undo step. */
  addShapes: (shapes: Shape[]) => void;
  shapeCount: () => number;
  deleteSelected: () => boolean;
  updateSelectedStyle: (style: ShapeStyle) => void;
  /** Current shapes (image edits bake them and restore them on undo). */
  snapshot: () => Shape[];
  /** Replace all shapes with `shapes` and reset annotation history. */
  restore: (shapes: Shape[]) => void;
}

export interface ShapeStyle {
  color?: string;
  lineWidth?: number;
  fontFamily?: string;
  fontSize?: number;
  filled?: boolean;
}

interface AnnotationCanvasProps {
  /** CSS-pixel display size of the background image. */
  imageWidth: number;
  imageHeight: number;
  tool: AnnotationTool;
  color: string;
  lineWidth: number;
  fontFamily?: string;
  fontSize?: number;
  textHint?: string;
  /** New rect / ellipse / pen shapes are solid. */
  fill?: boolean;
  /** `partial` removes pixels under the eraser; `object` deletes whole shapes. */
  eraserMode?: EraserMode;
  /** Loaded background image; sampled by mosaic and blur. */
  baseImage: HTMLImageElement | null;
  /** CSS-pixel rect annotations are clipped to; null = whole image. */
  selection: CssRect | null;
  /** Optional closed freehand boundary in the same CSS-pixel space. */
  selectionContour?: readonly ScreenshotPoint[] | null;
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
  /** Fired when the user presses a draw tool outside the selection. */
  onRequestReselect?: (at: Point) => void;
  onSelectionChange?: (shape: Shape | null) => void;
  /** True while a pointer stroke is in progress (toolbar fades out). */
  onDrawingChange?: (drawing: boolean) => void;
}

const TEXT_FONT_SIZE = 18;
export const FONT_STACK = 'Inter, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

const TEXT_LINE_HEIGHT = 1.2;

/** Measure each explicit line with the same font used for live and exported text. */
function textBounds(shape: TextShape): CssRect {
  const lines = shape.text.split("\n");
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx) ctx.font = `600 ${shape.fontSize}px ${shape.fontFamily ?? FONT_STACK}`;
  const widths = lines.map((line) => ctx?.measureText(line)?.width ?? line.length * shape.fontSize);
  return { x: shape.x, y: shape.y, w: Math.max(shape.fontSize, ...widths), h: lines.length * shape.fontSize * TEXT_LINE_HEIGHT };
}

function inRect(p: Point, r: CssRect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normRect(r: { x: number; y: number; w: number; h: number }): CssRect {
  return {
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

/** Device pixels per canvas unit (live view: dpr; export: natural scale). */
function pixelRatio(ctx: CanvasRenderingContext2D): number {
  try {
    return Math.abs(ctx.getTransform().a) || 1;
  } catch {
    return 1;
  }
}

/** Pixelate a rect sampled from the natural-size base image. */
function paintMosaic(
  ctx: CanvasRenderingContext2D,
  base: HTMLImageElement,
  shape: CssRect,
  sampleScaleX: number,
  sampleScaleY: number,
): void {
  const r = normRect(shape);
  if (r.w < 1 || r.h < 1) return;
  const block = 10;
  const tw = Math.max(1, Math.round(r.w / block));
  const th = Math.max(1, Math.round(r.h / block));
  const tiny = document.createElement("canvas");
  tiny.width = tw;
  tiny.height = th;
  const tctx = tiny.getContext("2d");
  if (!tctx) return;
  tctx.drawImage(base, r.x * sampleScaleX, r.y * sampleScaleY, r.w * sampleScaleX, r.h * sampleScaleY, 0, 0, tw, th);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, tw, th, r.x, r.y, r.w, r.h);
  ctx.restore();
}

/** Gaussian-blur a rect of the base image (clipped, no soft edges). */
function paintBlur(
  ctx: CanvasRenderingContext2D,
  base: HTMLImageElement,
  shape: CssRect,
  sampleScaleX: number,
  sampleScaleY: number,
): void {
  const r = normRect(shape);
  if (r.w < 1 || r.h < 1) return;
  const radius = 8;
  const pad = radius * 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.filter = `blur(${radius * pixelRatio(ctx)}px)`;
  ctx.drawImage(
    base,
    (r.x - pad) * sampleScaleX,
    (r.y - pad) * sampleScaleY,
    (r.w + pad * 2) * sampleScaleX,
    (r.h + pad * 2) * sampleScaleY,
    r.x - pad,
    r.y - pad,
    r.w + pad * 2,
    r.h + pad * 2,
  );
  ctx.restore();
}

function paintArrow(ctx: CanvasRenderingContext2D, s: LineLikeShape): void {
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const headLen = Math.max(12, s.lineWidth * 4);
  const spread = Math.PI / 7;
  // Stop the shaft inside the head so wide lines keep a sharp tip.
  const shaftEnd = {
    x: s.x2 - Math.cos(angle) * headLen * 0.6,
    y: s.y2 - Math.sin(angle) * headLen * 0.6,
  };
  ctx.beginPath();
  ctx.moveTo(s.x1, s.y1);
  ctx.lineTo(shaftEnd.x, shaftEnd.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s.x2, s.y2);
  for (const dir of [-1, 1]) {
    const a = angle + Math.PI + dir * spread;
    ctx.lineTo(s.x2 + headLen * Math.cos(a), s.y2 + headLen * Math.sin(a));
  }
  ctx.closePath();
  ctx.fill();
}

function paintPolyline(ctx: CanvasRenderingContext2D, pts: Point[]): void {
  if (pts.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  } else if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Scratch layer for shapes with erase masks (painting is sequential). */
let eraseLayer: HTMLCanvasElement | null = null;

/**
 * Paint one shape in canvas CSS-px space (the caller's transform maps it to
 * device pixels). `sampleScaleX`/`sampleScaleY` map CSS px to base-image
 * natural px per axis; a single scale still samples both axes equally.
 */
export function paintShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  base: HTMLImageElement | null,
  sampleScaleX: number,
  sampleScaleY: number = sampleScaleX,
): void {
  const target = ctx.canvas as HTMLCanvasElement | undefined;
  if (shape.erase?.length && target?.width && target.height) {
    // Render on a same-size layer, punch the erased strokes out of it, then
    // composite: erasing never reveals or removes the screenshot underneath.
    const layer = (eraseLayer ??= document.createElement("canvas"));
    if (layer.width !== target.width || layer.height !== target.height) {
      layer.width = target.width;
      layer.height = target.height;
    }
    const lctx = layer.getContext("2d");
    if (lctx) {
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, layer.width, layer.height);
      lctx.setTransform(ctx.getTransform());
      paintShapeBody(lctx, shape, base, sampleScaleX, sampleScaleY);
      lctx.save();
      lctx.globalCompositeOperation = "destination-out";
      lctx.strokeStyle = "#000";
      lctx.fillStyle = "#000";
      lctx.lineCap = "round";
      lctx.lineJoin = "round";
      for (const stroke of shape.erase) {
        lctx.lineWidth = stroke.width;
        paintPolyline(lctx, stroke.pts);
      }
      lctx.restore();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
      return;
    }
  }
  paintShapeBody(ctx, shape, base, sampleScaleX, sampleScaleY);
}

function paintShapeBody(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  base: HTMLImageElement | null,
  sampleScaleX: number,
  sampleScaleY: number,
): void {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = Math.max(1, shape.lineWidth);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (shape.kind) {
    case "rect": {
      const r = normRect(shape);
      if (shape.filled) ctx.fillRect(r.x, r.y, r.w, r.h);
      else ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case "ellipse": {
      const r = normRect(shape);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 2), Math.max(0.5, r.h / 2), 0, 0, Math.PI * 2);
      if (shape.filled) ctx.fill();
      else ctx.stroke();
      break;
    }
    case "line":
      ctx.beginPath();
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(shape.x2, shape.y2);
      ctx.stroke();
      break;
    case "arrow":
      paintArrow(ctx, shape);
      break;
    case "pen":
      if (shape.filled && shape.pts.length >= 3) {
        // Closed freehand region; the outline keeps thin shapes visible.
        ctx.beginPath();
        ctx.moveTo(shape.pts[0].x, shape.pts[0].y);
        for (let i = 1; i < shape.pts.length; i++) ctx.lineTo(shape.pts[i].x, shape.pts[i].y);
        ctx.closePath();
        ctx.fill("evenodd");
        ctx.stroke();
      } else paintPolyline(ctx, shape.pts);
      break;
    case "highlighter":
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = Math.max(8, shape.lineWidth * 3);
      ctx.lineCap = "square";
      paintPolyline(ctx, shape.pts);
      break;
    case "text":
      ctx.font = `600 ${shape.fontSize}px ${shape.fontFamily ?? FONT_STACK}`;
      ctx.textBaseline = "top";
      // Thin dark outline keeps light colors readable on light content.
      ctx.lineWidth = Math.max(2, shape.fontSize / 8);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      shape.text.split("\n").forEach((line, index) => {
        const y = shape.y + index * shape.fontSize * TEXT_LINE_HEIGHT;
        ctx.strokeText(line, shape.x, y);
        ctx.fillText(line, shape.x, y);
      });
      break;
    case "mosaic":
      if (base) paintMosaic(ctx, base, shape, sampleScaleX, sampleScaleY);
      break;
    case "blur":
      if (base) paintBlur(ctx, base, shape, sampleScaleX, sampleScaleY);
      break;
    case "number": {
      // Flameshot-style numbered marker: filled circle with a white number.
      const r = Math.max(12, 9 + shape.lineWidth * 1.5);
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `600 ${Math.max(10, r * 1.1)}px ${FONT_STACK}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(shape.num), shape.x, shape.y + r * 0.06);
      break;
    }
    case "balloon": {
      // Speech balloon: rounded rect with a tail pointing to (tx, ty).
      const b = normRect(shape);
      const radius = Math.min(16, b.w / 4, b.h / 4);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const angle = Math.atan2(shape.ty - cy, shape.tx - cx);
      const edgeX = cx + Math.cos(angle) * (b.w / 2) * 0.8;
      const edgeY = cy + Math.sin(angle) * (b.h / 2) * 0.8;
      const perp = angle + Math.PI / 2;
      const spread = Math.min(18, b.w / 4, b.h / 4);
      ctx.beginPath();
      ctx.moveTo(shape.tx, shape.ty);
      ctx.lineTo(edgeX + Math.cos(perp) * spread, edgeY + Math.sin(perp) * spread);
      ctx.lineTo(edgeX - Math.cos(perp) * spread, edgeY - Math.sin(perp) * spread);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, radius);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

function rectFromDrag(a: Point, b: Point): CssRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function distToSegment(p: Point, a: Point, b: Point): number {
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

/** Half the painted width of a stroke-like shape. */
function strokeHalfWidth(shape: Shape): number {
  return shape.kind === "highlighter" ? Math.max(8, shape.lineWidth * 3) / 2 : Math.max(1, shape.lineWidth) / 2;
}

/** Centre line of shapes whose pixels are fully described by a stroke. */
function strokePath(shape: Shape): Point[] | null {
  if ((shape.kind === "pen" && !shape.filled) || shape.kind === "highlighter") return shape.pts;
  if (shape.kind === "line") return [{ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }];
  return null;
}

/** Whether every painted pixel of a stroke lies under its erase masks. */
function fullyErased(shape: Shape): boolean {
  const path = strokePath(shape);
  if (!path || !shape.erase?.length) return false;
  const half = strokeHalfWidth(shape);
  return resamplePath(path, Math.max(0.5, half / 2))
    .every((p) => shape.erase!.some((s) => distToPath(p, s.pts) + half <= s.width / 2));
}

/** Whether the eraser at `p` touches visible pixels of `shape`. */
function eraseHitTest(shape: Shape, p: Point, radius: number): boolean {
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

function transformGeometry(shape: Shape, x: (v: number) => number, y: (v: number) => number, sx: number, sy: number): Shape {
  switch (shape.kind) {
    case "rect": case "ellipse": case "mosaic": case "blur":
      return { ...shape, x: x(shape.x), y: y(shape.y), w: shape.w * sx, h: shape.h * sy };
    case "balloon": return { ...shape, x: x(shape.x), y: y(shape.y), w: shape.w * sx, h: shape.h * sy, tx: x(shape.tx), ty: y(shape.ty) };
    case "line": case "arrow": return { ...shape, x1: x(shape.x1), y1: y(shape.y1), x2: x(shape.x2), y2: y(shape.y2) };
    case "pen": case "highlighter": return { ...shape, pts: shape.pts.map((p) => ({ x: x(p.x), y: y(p.y) })) };
    case "text": return { ...shape, x: x(shape.x), y: y(shape.y), fontSize: Math.max(8, shape.fontSize * sy) };
    case "number": return { ...shape, x: x(shape.x), y: y(shape.y), lineWidth: Math.max(1, shape.lineWidth * Math.min(sx, sy)) };
  }
}

/** Snapshot history: every mutation pushes the previous shape list. */
export interface History {
  shapes: Shape[];
  undo: Shape[][];
  redo: Shape[][];
}

export function commit(h: History, next: Shape[]): History {
  return { shapes: next, undo: [...h.undo, h.shapes], redo: [] };
}

export function undoHistory(h: History): History {
  if (h.undo.length === 0) return h;
  return { shapes: h.undo[h.undo.length - 1], undo: h.undo.slice(0, -1), redo: [...h.redo, h.shapes] };
}

export function redoHistory(h: History): History {
  if (h.redo.length === 0) return h;
  return { shapes: h.redo[h.redo.length - 1], undo: [...h.undo, h.shapes], redo: h.redo.slice(0, -1) };
}

const EMPTY_HISTORY: History = { shapes: [], undo: [], redo: [] };

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(
  function AnnotationCanvas(props, ref) {
    const { imageWidth, imageHeight, tool, color, lineWidth, fontFamily = FONT_STACK, fontSize = TEXT_FONT_SIZE, textHint, baseImage, selection, selectionContour, onHistoryChange, onRequestReselect,
      fill = false, eraserMode = "partial" } = props;
    const filled = fill && FILLABLE_TOOLS.includes(tool) ? true : undefined;

    const wrapRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [history, setHistory] = useState<History>(EMPTY_HISTORY);
    const historyRef = useRef<History>(EMPTY_HISTORY);
    const [draft, setDraft] = useState<Shape | null>(null);
    const [eraserTrail, setEraserTrail] = useState<Point[] | null>(null);
    const [textAt, setTextAt] = useState<Point | null>(null);
    const [textValue, setTextValue] = useState("");
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [editedShape, setEditedShape] = useState<Shape | null>(null);
    const textInputRef = useRef<HTMLTextAreaElement | null>(null);
    const textOpenRef = useRef(false);
    const editingTextRef = useRef<TextShape | null>(null);
    const movingRef = useRef<{ shape: Shape; start: Point; bounds: CssRect; corner?: "nw" | "ne" | "sw" | "se" } | null>(null);
    const idRef = useRef(1);
    const drawingRef = useRef<{ start: Point; pts: Point[] } | null>(null);
    /** Set when a mousedown already placed a number marker for this click. */
    const numberPlacedRef = useRef(false);
    const drawingActiveRef = useRef(false);

    const apply = useCallback((next: History) => {
      historyRef.current = next;
      setHistory(next);
    }, []);

    const mutate = useCallback(
      (next: Shape[]) => apply(commit(historyRef.current, next)),
      [apply],
    );

    const selected = history.shapes.find((s) => s.id === selectedId) ?? null;
    useLayoutEffect(() => {
      props.onSelectionChange?.(tool === "move" ? selected : null);
    }, [selected, tool, props.onSelectionChange]);

    const deleteSelected = useCallback(() => {
      if (selectedId === null || !historyRef.current.shapes.some((s) => s.id === selectedId)) return false;
      mutate(historyRef.current.shapes.filter((s) => s.id !== selectedId));
      setSelectedId(null);
      return true;
    }, [mutate, selectedId]);
    const updateSelectedStyle = useCallback((style: ShapeStyle) => {
      if (selectedId === null) return;
      mutate(historyRef.current.shapes.map((s) => {
        if (s.id !== selectedId) return s;
        const { filled, ...rest } = style;
        const next = { ...s, ...rest } as Shape;
        // Fill applies only to shapes that have a solid form.
        if (filled !== undefined && (next.kind === "rect" || next.kind === "ellipse" || next.kind === "pen")) next.filled = filled || undefined;
        return next;
      }));
    }, [mutate, selectedId]);

    // Toolbar availability is part of the same visible history update;
    // a passive effect exposes stale enabled/disabled state for one paint.
    useLayoutEffect(() => {
      onHistoryChange?.(history.undo.length > 0, history.redo.length > 0);
    }, [history, onHistoryChange]);

    const nextNumber = () =>
      historyRef.current.shapes.reduce((n, s) => (s.kind === "number" ? Math.max(n, s.num) : n), 0) + 1;

    const addShape = useCallback(
      (shape: Shape) => mutate([...historyRef.current.shapes, { ...shape, id: idRef.current++ }]),
      [mutate],
    );

    const addShapes = useCallback(
      (newShapes: Shape[]) => {
        if (newShapes.length === 0) return;
        mutate([...historyRef.current.shapes, ...newShapes.map((s) => ({ ...s, id: idRef.current++ }))]);
      },
      [mutate],
    );

    const undo = useCallback(() => apply(undoHistory(historyRef.current)), [apply]);
    const redo = useCallback(() => apply(redoHistory(historyRef.current)), [apply]);

    const clear = useCallback(() => {
      apply(EMPTY_HISTORY);
      setDraft(null);
      setTextAt(null);
      setTextValue("");
      setSelectedId(null);
      setEditedShape(null);
      movingRef.current = null;
      editingTextRef.current = null;
      textOpenRef.current = false;
    }, [apply]);

    const exportDataUrl = useCallback((base: HTMLImageElement, sx: number, sy: number): string => {
      const c = document.createElement("canvas");
      c.width = base.naturalWidth;
      c.height = base.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.drawImage(base, 0, 0);
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
      for (const shape of historyRef.current.shapes) paintShape(ctx, shape, base, sx, sy);
      return c.toDataURL("image/png");
    }, []);

    const restore = useCallback((shapes: Shape[]) => {
      clear();
      idRef.current = shapes.reduce((n, s) => Math.max(n, s.id), 0) + 1;
      apply({ shapes, undo: [], redo: [] });
    }, [apply, clear]);

    useImperativeHandle(
      ref,
      () => ({ undo, redo, clear, exportDataUrl, addShapes, deleteSelected, updateSelectedStyle, restore,
        snapshot: () => historyRef.current.shapes, shapeCount: () => historyRef.current.shapes.length }),
      [undo, redo, clear, exportDataUrl, addShapes, deleteSelected, updateSelectedStyle, restore],
    );

    const drawingChange = props.onDrawingChange;
    const setDrawing = (value: boolean) => {
      if (drawingActiveRef.current === value) return;
      drawingActiveRef.current = value;
      drawingChange?.(value);
    };

    // Live redraw (HiDPI-aware; CSS-px coordinate space).
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(imageWidth * dpr));
      const h = Math.max(1, Math.round(imageHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (selection) {
        ctx.save();
        if (selectionContour) {
          traceContour(ctx, selectionContour);
          ctx.clip("evenodd");
        } else {
          ctx.beginPath();
          ctx.rect(selection.x, selection.y, selection.w, selection.h);
          ctx.clip();
        }
      }
      const sampleScaleX = baseImage ? baseImage.naturalWidth / Math.max(1, imageWidth) : 1;
      const sampleScaleY = baseImage ? baseImage.naturalHeight / Math.max(1, imageHeight) : 1;
      const stored = editedShape ? history.shapes.map((s) => s.id === editedShape.id ? editedShape : s) : history.shapes;
      const all = draft ? [...stored, draft] : stored;
      for (const shape of all) {
        if (textAt && shape.id === editingTextRef.current?.id) continue;
        paintShape(ctx, shape, baseImage, sampleScaleX, sampleScaleY);
      }
      if (selection) ctx.restore();
      if (eraserTrail && eraserTrail.length > 0) {
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
        ctx.lineWidth = eraserRadius(lineWidth) * 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalAlpha = 0.35;
        paintPolyline(ctx, eraserTrail);
        ctx.restore();
      }
    }, [history, draft, editedShape, textAt, eraserTrail, selection, selectionContour, baseImage, imageWidth, imageHeight, lineWidth]);

    const localPos = (e: { clientX: number; clientY: number }): Point => {
      const r = wrapRef.current?.getBoundingClientRect();
      // A document preview scales the whole canvas while keeping its shapes in
      // original-image coordinates. Include that scale and the scroll offset.
      return {
        x: (e.clientX - (r?.left ?? 0)) * (r?.width ? imageWidth / r.width : 1),
        y: (e.clientY - (r?.top ?? 0)) * (r?.height ? imageHeight / r.height : 1),
      };
    };

    /** Keep a drag point inside the selection so shapes stay visible. */
    const clampToSelection = (p: Point): Point =>
      selection
        ? {
            x: Math.min(Math.max(p.x, selection.x), selection.x + selection.w),
            y: Math.min(Math.max(p.y, selection.y), selection.y + selection.h),
          }
        : p;

    const makeDraft = (a: Point, b: Point, constrain = false): Shape | null => {
      if (constrain && (tool === "rect" || tool === "ellipse")) {
        const side = Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        b = { x: a.x + Math.sign(b.x - a.x) * side, y: a.y + Math.sign(b.y - a.y) * side };
      }
      const base = { id: -1, color, lineWidth };
      switch (tool) {
        case "rect":
        case "ellipse":
          return { ...base, kind: tool, ...rectFromDrag(a, b), filled };
        case "mosaic":
        case "blur":
          return { ...base, kind: tool, ...rectFromDrag(a, b) };
        case "line":
        case "arrow":
          return { ...base, kind: tool, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        case "pen":
          return { ...base, kind: tool, pts: [a, b], filled };
        case "highlighter":
          return { ...base, kind: tool, pts: [a, b] };
        case "balloon":
          // Drag from the target (tail tip) to the balloon's far corner.
          return { ...base, kind: "balloon", ...rectFromDrag(midpoint(a, b), b), tx: a.x, ty: a.y };
        default:
          return null;
      }
    };

    const placeNumber = (p: Point) => {
      addShape({ id: -1, kind: "number", x: p.x, y: p.y, num: nextNumber(), color, lineWidth });
    };

    const outsideSelection = (p: Point) => selection !== null
      && (selectionContour ? !pointInContour(p, selectionContour) : !inRect(p, selection));

    const handleMouseDown = (e: ReactMouseEvent) => {
      if (e.button !== 0 || tool === "select") return;
      const p = localPos(e);
      if (outsideSelection(p)) {
        onRequestReselect?.(p);
        return;
      }
      if (tool === "move") {
        const hit = [...historyRef.current.shapes].reverse().find((s) => shapeHitTest(s, p, Math.max(5, s.lineWidth)));
        setSelectedId(hit?.id ?? null);
        if (hit) movingRef.current = { shape: hit, start: p, bounds: shapeBounds(hit) };
        return;
      }
      // Text opens its input on click (a drag's mouseup would blur it).
      if (tool === "text") return;
      if (tool === "number") {
        placeNumber(p);
        numberPlacedRef.current = true;
        return;
      }
      drawingRef.current = { start: p, pts: [p] };
      setDrawing(true);
      if (tool === "eraser") {
        setEraserTrail([p]);
        return;
      }
      const d = makeDraft(p, p);
      if (d) setDraft(d);
    };

    const handleMouseMove = (e: ReactMouseEvent) => {
      const move = movingRef.current;
      if (move) {
        const p = clampToSelection(localPos(e));
        let bounds: CssRect;
        if (move.corner) {
          const opposite = { x: move.corner.endsWith("w") ? move.bounds.x + move.bounds.w : move.bounds.x,
            y: move.corner.startsWith("n") ? move.bounds.y + move.bounds.h : move.bounds.y };
          bounds = rectFromDrag(opposite, p);
          if (bounds.w < 4 || bounds.h < 4) return;
        } else {
          const clip = selection ?? { x: 0, y: 0, w: imageWidth, h: imageHeight };
          bounds = { ...move.bounds,
            x: Math.max(clip.x, Math.min(move.bounds.x + p.x - move.start.x, clip.x + clip.w - move.bounds.w)),
            y: Math.max(clip.y, Math.min(move.bounds.y + p.y - move.start.y, clip.y + clip.h - move.bounds.h)) };
        }
        setEditedShape(transformShape(move.shape, move.bounds, bounds));
        return;
      }
      const d = drawingRef.current;
      if (!d || tool === "select" || tool === "text") return;
      const p = clampToSelection(localPos(e));
      if (tool === "eraser") {
        d.pts = [...d.pts, p];
        setEraserTrail(d.pts);
      } else if (tool === "pen" || tool === "highlighter") {
        d.pts = [...d.pts, p];
        setDraft({ id: -1, color, lineWidth, kind: tool, pts: d.pts, filled: tool === "pen" ? filled : undefined });
      } else {
        const next = makeDraft(d.start, p, e.shiftKey);
        if (next) setDraft(next);
      }
    };

    const finishDrawing = (e: { clientX: number; clientY: number; shiftKey?: boolean }) => {
      if (movingRef.current) {
        if (editedShape && JSON.stringify(editedShape) !== JSON.stringify(movingRef.current.shape)) {
          mutate(historyRef.current.shapes.map((s) => s.id === editedShape.id ? editedShape : s));
        }
        movingRef.current = null;
        setEditedShape(null);
        return;
      }
      const d = drawingRef.current;
      drawingRef.current = null;
      setDrawing(false);
      setDraft(null);
      setEraserTrail(null);
      if (!d || tool === "select" || tool === "text" || tool === "number") return;
      const p = clampToSelection(localPos(e));
      if (tool === "eraser") {
        const pts = [...d.pts, p];
        const radius = eraserRadius(lineWidth);
        const prev = historyRef.current.shapes;
        if (eraserMode === "partial") {
          const next = eraseShapes(prev, pts, radius);
          if (next !== prev) mutate([...next]);
          return;
        }
        const kept = prev.filter((s) => !pts.some((pt) => shapeHitTest(s, pt, radius)));
        if (kept.length !== prev.length) mutate(kept);
        return;
      }
      let shape: Shape | null;
      if (tool === "pen" || tool === "highlighter") {
        const pts = [...d.pts, p];
        shape = { id: -1, color, lineWidth, kind: tool, pts, filled: tool === "pen" ? filled : undefined };
      } else {
        shape = makeDraft(d.start, p, e.shiftKey);
      }
      if (!shape) return;
      let valid = false;
      if (shape.kind === "rect" || shape.kind === "ellipse" || shape.kind === "mosaic" || shape.kind === "blur") {
        valid = Math.abs(shape.w) >= 3 && Math.abs(shape.h) >= 3;
      } else if (shape.kind === "line" || shape.kind === "arrow") {
        valid = dist({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) >= 5;
      } else if (shape.kind === "pen" || shape.kind === "highlighter") {
        valid = shape.pts.length >= 2;
        if (shape.kind === "pen" && shape.filled) {
          // A solid freehand region needs an area; a short flick stays a line.
          const b = shapeBounds(shape);
          if (shape.pts.length < 3 || b.w < 3 || b.h < 3) shape = { ...shape, filled: undefined };
        }
      } else if (shape.kind === "balloon") {
        valid = Math.abs(shape.w) >= 16 && Math.abs(shape.h) >= 12;
      }
      if (valid) addShape(shape);
    };

    // A drag released outside the layer (over the toolbar or off-window)
    // still finishes the shape.
    useEffect(() => {
      const onUp = (e: MouseEvent) => {
        if (drawingRef.current || movingRef.current) finishDrawing(e);
      };
      window.addEventListener("mouseup", onUp);
      const onMove = (e: MouseEvent) => { if ((movingRef.current || drawingRef.current) && !wrapRef.current?.contains(e.target as Node)) handleMouseMove(e as unknown as ReactMouseEvent); };
      window.addEventListener("mousemove", onMove);
      return () => { window.removeEventListener("mouseup", onUp); window.removeEventListener("mousemove", onMove); };
    });

    const commitText = () => {
      if (!textOpenRef.current) return;
      textOpenRef.current = false;
      if (textAt && textValue.trim()) {
        const original = editingTextRef.current;
        const next: TextShape = {
          id: -1,
          color,
          lineWidth,
          kind: "text",
          x: textAt.x,
          y: textAt.y,
          text: textValue,
          fontSize: original?.fontSize ?? fontSize,
          fontFamily: original?.fontFamily ?? fontFamily,
        };
        if (original) mutate(historyRef.current.shapes.map((s) => s.id === original.id ? { ...next, id: original.id, color: original.color, lineWidth: original.lineWidth } : s));
        else addShape(next);
      }
      editingTextRef.current = null;
      setTextAt(null);
      setTextValue("");
    };

    // WebKit need not blur a textarea when a non-focusable canvas is clicked.
    useEffect(() => {
      if (!textAt) return;
      const onDown = (event: MouseEvent) => {
        if (!textInputRef.current?.contains(event.target as Node)) commitText();
      };
      window.addEventListener("mousedown", onDown, true);
      return () => window.removeEventListener("mousedown", onDown, true);
    });

    const handleClick = (e: ReactMouseEvent) => {
      if (tool !== "text" && tool !== "number") return;
      const p = localPos(e);
      if (outsideSelection(p)) return;
      if (tool === "text") {
        textOpenRef.current = true;
        setTextAt(p);
        setTextValue("");
        return;
      }
      // Synthetic clicks without a mousedown (some automation) still place.
      if (numberPlacedRef.current) {
        numberPlacedRef.current = false;
        return;
      }
      placeNumber(p);
    };

    const interactive = tool !== "select";

    return (
      <div
        ref={wrapRef}
        data-testid="screenshot-annotation-layer"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        onDoubleClick={(e) => {
          if (tool !== "move") return;
          const p = localPos(e);
          const hit = [...historyRef.current.shapes].reverse().find((s) => shapeHitTest(s, p, 5));
          if (hit?.kind !== "text") return;
          textOpenRef.current = true;
          editingTextRef.current = hit;
          setTextAt({ x: hit.x, y: hit.y });
          setTextValue(hit.text);
        }}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: imageWidth,
          height: imageHeight,
          // Above the region-select layer so draw tools receive pointer
          // events; below the selection handles and the toolbar.
          zIndex: 30,
          pointerEvents: interactive ? "auto" : "none",
          cursor: tool === "move" ? "default" : interactive ? (tool === "text" ? "text" : "crosshair") : "default",
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="screenshot-annotation-canvas"
          data-shapes={history.shapes.length}
          style={{ display: "block", width: imageWidth, height: imageHeight }}
        />
        {tool === "move" && selected && (() => {
          const bounds = shapeBounds(editedShape ?? selected);
          return <div data-testid="screenshot-annotation-selection" data-kind={selected.kind}
            style={{ position: "absolute", left: bounds.x, top: bounds.y, width: Math.max(1, bounds.w), height: Math.max(1, bounds.h), border: "1px dashed #1677ff", pointerEvents: "none" }}>
            {(["nw", "ne", "sw", "se"] as const).map((corner) => <div key={corner} data-testid={`screenshot-annotation-resize-${corner}`}
              onMouseDown={(e) => { e.stopPropagation(); movingRef.current = { shape: selected, start: localPos(e), bounds: shapeBounds(selected), corner }; }}
              style={{ position: "absolute", width: 8, height: 8, background: "#fff", border: "1px solid #1677ff", pointerEvents: "auto", cursor: `${corner}-resize`, left: corner.endsWith("w") ? -4 : "calc(100% - 4px)", top: corner.startsWith("n") ? -4 : "calc(100% - 4px)" }} />)}
          </div>;
        })()}
        {textAt && (
          <textarea
            ref={textInputRef}
            autoFocus
            aria-label={textHint}
            title={textHint}
            rows={Math.max(1, textValue.split("\n").length)}
            wrap="off"
            data-testid="screenshot-text-input"
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commitText();
              }
              else if (e.key === "Escape") {
                textOpenRef.current = false;
                editingTextRef.current = null;
                setTextAt(null);
                setTextValue("");
              }
            }}
            onBlur={commitText}
            style={{
              position: "absolute",
              // Padding offsets so the typed text sits where it will render.
              left: textAt.x - 4,
              top: textAt.y - 2,
              width: Math.max(120, Math.min(imageWidth - textAt.x, textBounds({ id: -1, kind: "text", x: 0, y: 0, text: textValue + "  ", color, lineWidth,
                fontSize: editingTextRef.current?.fontSize ?? fontSize, fontFamily: editingTextRef.current?.fontFamily ?? fontFamily }).w + 12)),
              maxWidth: Math.max(40, imageWidth - textAt.x),
              maxHeight: Math.max(40, imageHeight - textAt.y),
              resize: "none",
              background: "rgba(0, 0, 0, 0.3)",
              border: `1px dashed ${color}`,
              outline: "none",
              color,
              fontSize: editingTextRef.current?.fontSize ?? fontSize,
              fontWeight: 600,
              lineHeight: TEXT_LINE_HEIGHT,
              fontFamily: editingTextRef.current?.fontFamily ?? fontFamily,
              padding: "2px 4px",
              zIndex: 5,
            }}
          />
        )}
      </div>
    );
  },
);

/** Eraser reach (CSS px) for the selected line width: 2/4/8 -> 6/8/16. */
export function eraserRadius(lineWidth: number): number {
  return Math.max(6, lineWidth * 2);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
