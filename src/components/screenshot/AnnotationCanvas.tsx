import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

export type AnnotationTool =
  | "select"
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

interface ShapeBase {
  id: number;
  color: string;
  lineWidth: number;
}

export interface RectLikeShape extends ShapeBase {
  kind: "rect" | "ellipse" | "mosaic" | "blur";
  x: number;
  y: number;
  w: number;
  h: number;
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
}

export interface TextShape extends ShapeBase {
  kind: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
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
}

interface AnnotationCanvasProps {
  /** CSS-pixel display size of the background image. */
  imageWidth: number;
  imageHeight: number;
  tool: AnnotationTool;
  color: string;
  lineWidth: number;
  /** Loaded background image; sampled by mosaic and blur. */
  baseImage: HTMLImageElement | null;
  /** CSS-pixel rect annotations are clipped to; null = whole image. */
  selection: CssRect | null;
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
  /** Fired when the user presses a draw tool outside the selection. */
  onRequestReselect?: (at: Point) => void;
}

const TEXT_FONT_SIZE = 18;
const FONT_STACK = 'Inter, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

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
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = Math.max(1, shape.lineWidth);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (shape.kind) {
    case "rect": {
      const r = normRect(shape);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case "ellipse": {
      const r = normRect(shape);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 2), Math.max(0.5, r.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
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
      paintPolyline(ctx, shape.pts);
      break;
    case "highlighter":
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = Math.max(8, shape.lineWidth * 3);
      ctx.lineCap = "square";
      paintPolyline(ctx, shape.pts);
      break;
    case "text":
      ctx.font = `600 ${shape.fontSize}px ${FONT_STACK}`;
      ctx.textBaseline = "top";
      // Thin dark outline keeps light colors readable on light content.
      ctx.lineWidth = Math.max(2, shape.fontSize / 8);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      ctx.strokeText(shape.text, shape.x, shape.y);
      ctx.fillText(shape.text, shape.x, shape.y);
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

/** Whether `p` is within `radius` of a shape's geometry (eraser). */
export function shapeHitTest(shape: Shape, p: Point, radius: number): boolean {
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
      return shape.pts.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) <= radius + shape.lineWidth);
    case "text": {
      const w = shape.text.length * shape.fontSize * 0.6;
      return (
        p.x >= shape.x - radius &&
        p.x <= shape.x + w + radius &&
        p.y >= shape.y - radius &&
        p.y <= shape.y + shape.fontSize + radius
      );
    }
    case "number":
      return Math.hypot(shape.x - p.x, shape.y - p.y) <= radius + 14;
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
    const { imageWidth, imageHeight, tool, color, lineWidth, baseImage, selection, onHistoryChange, onRequestReselect } =
      props;

    const wrapRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [history, setHistory] = useState<History>(EMPTY_HISTORY);
    const historyRef = useRef<History>(EMPTY_HISTORY);
    const [draft, setDraft] = useState<Shape | null>(null);
    const [eraserTrail, setEraserTrail] = useState<Point[] | null>(null);
    const [textAt, setTextAt] = useState<Point | null>(null);
    const [textValue, setTextValue] = useState("");
    const idRef = useRef(1);
    const drawingRef = useRef<{ start: Point; pts: Point[] } | null>(null);
    /** Set when a mousedown already placed a number marker for this click. */
    const numberPlacedRef = useRef(false);

    const apply = useCallback((next: History) => {
      historyRef.current = next;
      setHistory(next);
    }, []);

    const mutate = useCallback(
      (next: Shape[]) => apply(commit(historyRef.current, next)),
      [apply],
    );

    useEffect(() => {
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

    useImperativeHandle(
      ref,
      () => ({ undo, redo, clear, exportDataUrl, addShapes, shapeCount: () => historyRef.current.shapes.length }),
      [undo, redo, clear, exportDataUrl, addShapes],
    );

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
        ctx.beginPath();
        ctx.rect(selection.x, selection.y, selection.w, selection.h);
        ctx.clip();
      }
      const sampleScaleX = baseImage ? baseImage.naturalWidth / Math.max(1, imageWidth) : 1;
      const sampleScaleY = baseImage ? baseImage.naturalHeight / Math.max(1, imageHeight) : 1;
      const all = draft ? [...history.shapes, draft] : history.shapes;
      for (const shape of all) paintShape(ctx, shape, baseImage, sampleScaleX, sampleScaleY);
      if (selection) ctx.restore();
      if (eraserTrail && eraserTrail.length > 0) {
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
        ctx.lineWidth = Math.max(10, lineWidth * 2) * 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalAlpha = 0.35;
        paintPolyline(ctx, eraserTrail);
        ctx.restore();
      }
    }, [history, draft, eraserTrail, selection, baseImage, imageWidth, imageHeight, lineWidth]);

    const localPos = (e: { clientX: number; clientY: number }): Point => {
      const r = wrapRef.current?.getBoundingClientRect();
      return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
    };

    /** Keep a drag point inside the selection so shapes stay visible. */
    const clampToSelection = (p: Point): Point =>
      selection
        ? {
            x: Math.min(Math.max(p.x, selection.x), selection.x + selection.w),
            y: Math.min(Math.max(p.y, selection.y), selection.y + selection.h),
          }
        : p;

    const makeDraft = (a: Point, b: Point): Shape | null => {
      const base = { id: -1, color, lineWidth };
      switch (tool) {
        case "rect":
        case "ellipse":
        case "mosaic":
        case "blur":
          return { ...base, kind: tool, ...rectFromDrag(a, b) };
        case "line":
        case "arrow":
          return { ...base, kind: tool, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        case "pen":
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

    const outsideSelection = (p: Point) => selection !== null && !inRect(p, selection);

    const handleMouseDown = (e: ReactMouseEvent) => {
      if (e.button !== 0 || tool === "select") return;
      const p = localPos(e);
      if (outsideSelection(p)) {
        onRequestReselect?.(p);
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
      if (tool === "eraser") {
        setEraserTrail([p]);
        return;
      }
      const d = makeDraft(p, p);
      if (d) setDraft(d);
    };

    const handleMouseMove = (e: ReactMouseEvent) => {
      const d = drawingRef.current;
      if (!d || tool === "select" || tool === "text") return;
      const p = clampToSelection(localPos(e));
      if (tool === "eraser") {
        d.pts = [...d.pts, p];
        setEraserTrail(d.pts);
      } else if (tool === "pen" || tool === "highlighter") {
        d.pts = [...d.pts, p];
        setDraft({ id: -1, color, lineWidth, kind: tool, pts: d.pts });
      } else {
        const next = makeDraft(d.start, p);
        if (next) setDraft(next);
      }
    };

    const finishDrawing = (e: { clientX: number; clientY: number }) => {
      const d = drawingRef.current;
      drawingRef.current = null;
      setDraft(null);
      setEraserTrail(null);
      if (!d || tool === "select" || tool === "text" || tool === "number") return;
      const p = clampToSelection(localPos(e));
      if (tool === "eraser") {
        const pts = [...d.pts, p];
        const radius = Math.max(10, lineWidth * 2);
        const prev = historyRef.current.shapes;
        const kept = prev.filter((s) => !pts.some((pt) => shapeHitTest(s, pt, radius)));
        if (kept.length !== prev.length) mutate(kept);
        return;
      }
      let shape: Shape | null;
      if (tool === "pen" || tool === "highlighter") {
        const pts = [...d.pts, p];
        shape = { id: -1, color, lineWidth, kind: tool, pts };
      } else {
        shape = makeDraft(d.start, p);
      }
      if (!shape) return;
      let valid = false;
      if (shape.kind === "rect" || shape.kind === "ellipse" || shape.kind === "mosaic" || shape.kind === "blur") {
        valid = Math.abs(shape.w) >= 3 && Math.abs(shape.h) >= 3;
      } else if (shape.kind === "line" || shape.kind === "arrow") {
        valid = dist({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) >= 5;
      } else if (shape.kind === "pen" || shape.kind === "highlighter") {
        valid = shape.pts.length >= 2;
      } else if (shape.kind === "balloon") {
        valid = Math.abs(shape.w) >= 16 && Math.abs(shape.h) >= 12;
      }
      if (valid) addShape(shape);
    };

    // A drag released outside the layer (over the toolbar or off-window)
    // still finishes the shape.
    useEffect(() => {
      const onUp = (e: MouseEvent) => {
        if (drawingRef.current) finishDrawing(e);
      };
      window.addEventListener("mouseup", onUp);
      return () => window.removeEventListener("mouseup", onUp);
    });

    const commitText = () => {
      if (textAt && textValue.trim()) {
        addShape({
          id: -1,
          color,
          lineWidth,
          kind: "text",
          x: textAt.x,
          y: textAt.y,
          text: textValue.trim(),
          fontSize: TEXT_FONT_SIZE,
        });
      }
      setTextAt(null);
      setTextValue("");
    };

    const handleClick = (e: ReactMouseEvent) => {
      if (tool !== "text" && tool !== "number") return;
      const p = localPos(e);
      if (outsideSelection(p)) return;
      if (tool === "text") {
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
          cursor: interactive ? (tool === "text" ? "text" : "crosshair") : "default",
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="screenshot-annotation-canvas"
          data-shapes={history.shapes.length}
          style={{ display: "block", width: imageWidth, height: imageHeight }}
        />
        {textAt && (
          <input
            autoFocus
            data-testid="screenshot-text-input"
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitText();
              else if (e.key === "Escape") {
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
              minWidth: 120,
              background: "rgba(0, 0, 0, 0.3)",
              border: `1px dashed ${color}`,
              outline: "none",
              color,
              fontSize: TEXT_FONT_SIZE,
              fontWeight: 600,
              lineHeight: 1,
              fontFamily: FONT_STACK,
              padding: "2px 4px",
              zIndex: 5,
            }}
          />
        )}
      </div>
    );
  },
);

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
