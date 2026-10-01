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
  exportDataUrl: (base: HTMLImageElement, scale: number) => string;
  /** Programmatically add shapes (e.g. auto-redact boxes). */
  addShapes: (shapes: Shape[]) => void;
}

interface AnnotationCanvasProps {
  /** CSS-pixel display size of the background image. */
  imageWidth: number;
  imageHeight: number;
  tool: AnnotationTool;
  color: string;
  lineWidth: number;
  /** Loaded background image; needed to sample pixels for mosaic. */
  baseImage: HTMLImageElement | null;
  /** CSS-pixel rect annotations are clipped to; null = whole image. */
  selection: CssRect | null;
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
  /** Fired when the user clicks outside the selection with a draw tool. */
  onRequestReselect?: () => void;
}

function inRect(p: Point, r: CssRect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Pixelate a CSS-pixel rect sampled from the natural-size base image. */
function paintMosaic(
  ctx: CanvasRenderingContext2D,
  base: HTMLImageElement,
  r: CssRect,
  /** Multiply CSS px -> output px for geometry. */
  s: number,
  /** Multiply CSS px -> base-image natural px for sampling. */
  sampleScale: number,
): void {
  const dw = Math.max(1, r.w * s);
  const dh = Math.max(1, r.h * s);
  const block = Math.max(2, 12 * s);
  const tw = Math.max(1, Math.round(dw / block));
  const th = Math.max(1, Math.round(dh / block));
  const tiny = document.createElement("canvas");
  tiny.width = tw;
  tiny.height = th;
  const tctx = tiny.getContext("2d");
  if (!tctx) return;
  tctx.drawImage(
    base,
    r.x * sampleScale,
    r.y * sampleScale,
    r.w * sampleScale,
    r.h * sampleScale,
    0,
    0,
    tw,
    th,
  );
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, tw, th, r.x * s, r.y * s, dw, dh);
  ctx.restore();
  ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
  ctx.fillRect(r.x * s, r.y * s, dw, dh);
}

function paintArrowHead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  s: number,
): void {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = 14 * s;
  const spread = Math.PI / 7;
  ctx.beginPath();
  for (const dir of [-1, 1]) {
    const a = angle + Math.PI + dir * spread;
    ctx.moveTo(x2 * s, y2 * s);
    ctx.lineTo(x2 * s + headLen * Math.cos(a), y2 * s + headLen * Math.sin(a));
  }
  ctx.stroke();
}

/**
 * Paint one shape. Coordinates are CSS px; `s` maps them to output px and
 * `sampleScale` maps them to base-image natural px (mosaic sampling).
 */
function paintShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  base: HTMLImageElement | null,
  s: number,
  sampleScale: number,
): void {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = Math.max(1, shape.lineWidth * s);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (shape.kind) {
    case "rect":
      ctx.strokeRect(shape.x * s, shape.y * s, shape.w * s, shape.h * s);
      break;
    case "ellipse": {
      const rx = Math.abs((shape.w / 2) * s);
      const ry = Math.abs((shape.h / 2) * s);
      ctx.beginPath();
      ctx.ellipse(
        (shape.x + shape.w / 2) * s,
        (shape.y + shape.h / 2) * s,
        Math.max(0.5, rx),
        Math.max(0.5, ry),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case "line":
      ctx.beginPath();
      ctx.moveTo(shape.x1 * s, shape.y1 * s);
      ctx.lineTo(shape.x2 * s, shape.y2 * s);
      ctx.stroke();
      break;
    case "arrow":
      ctx.beginPath();
      ctx.moveTo(shape.x1 * s, shape.y1 * s);
      ctx.lineTo(shape.x2 * s, shape.y2 * s);
      ctx.stroke();
      paintArrowHead(ctx, shape.x1, shape.y1, shape.x2, shape.y2, s);
      break;
    case "pen":
      if (shape.pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(shape.pts[0].x * s, shape.pts[0].y * s);
        for (let i = 1; i < shape.pts.length; i++) {
          ctx.lineTo(shape.pts[i].x * s, shape.pts[i].y * s);
        }
        ctx.stroke();
      } else if (shape.pts.length === 1) {
        ctx.beginPath();
        ctx.arc(shape.pts[0].x * s, shape.pts[0].y * s, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case "highlighter": {
      // Translucent marker strokes.
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = Math.max(8, shape.lineWidth * 3 * s);
      if (shape.pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(shape.pts[0].x * s, shape.pts[0].y * s);
        for (let i = 1; i < shape.pts.length; i++) {
          ctx.lineTo(shape.pts[i].x * s, shape.pts[i].y * s);
        }
        ctx.stroke();
      } else if (shape.pts.length === 1) {
        ctx.beginPath();
        ctx.arc(shape.pts[0].x * s, shape.pts[0].y * s, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = prevAlpha;
      break;
    }
    case "text":
      ctx.font = `${Math.max(8, shape.fontSize * s)}px Inter, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(shape.text, shape.x * s, shape.y * s);
      break;
    case "mosaic":
      if (base) {
        paintMosaic(
          ctx,
          base,
          { x: shape.x, y: shape.y, w: shape.w, h: shape.h },
          s,
          sampleScale,
        );
      }
      break;
    case "blur": {
      // Gaussian blur region (distinct from pixel mosaic).
      if (base) {
        const bx = shape.x * s;
        const by = shape.y * s;
        const bw = Math.abs(shape.w * s);
        const bh = Math.abs(shape.h * s);
        const sx = Math.min(shape.x, shape.x + shape.w) * s;
        const sy = Math.min(shape.y, shape.y + shape.h) * s;
        ctx.save();
        ctx.filter = `blur(${Math.max(2, 6 * s)}px)`;
        ctx.drawImage(base, sx, sy, bw, bh, bx, by, bw, bh);
        ctx.restore();
      }
      break;
    }
    case "number": {
      // Flameshot-style numbered marker: filled circle with a white number.
      const r = Math.max(12, 9 + shape.lineWidth * 1.5) * s;
      const cx = shape.x * s;
      const cy = shape.y * s;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `600 ${Math.max(10, r * 1.1)}px Inter, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(shape.num), cx, cy + r * 0.06);
      break;
    }
    case "balloon": {
      // Speech balloon: rounded rect with a tail pointing to (tx, ty).
      const bx = Math.min(shape.x, shape.x + shape.w) * s;
      const by = Math.min(shape.y, shape.y + shape.h) * s;
      const bw = Math.abs(shape.w * s);
      const bh = Math.abs(shape.h * s);
      const radius = Math.min(16 * s, bw / 4, bh / 4);
      const tx = shape.tx * s;
      const ty = shape.ty * s;
      // Tail triangle: from tail tip to two points on the balloon edge.
      const cx = bx + bw / 2;
      const cy = by + bh / 2;
      const angle = Math.atan2(ty - cy, tx - cx);
      const edgeX = cx + Math.cos(angle) * (bw / 2);
      const edgeY = cy + Math.sin(angle) * (bh / 2);
      const perp = angle + Math.PI / 2;
      const spread = Math.min(20 * s, bw / 4);
      const p1x = edgeX + Math.cos(perp) * spread;
      const p1y = edgeY + Math.sin(perp) * spread;
      const p2x = edgeX - Math.cos(perp) * spread;
      const p2y = edgeY - Math.sin(perp) * spread;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(p1x, p1y);
      ctx.lineTo(p2x, p2y);
      ctx.closePath();
      ctx.fill();
      // Rounded rect body.
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, radius);
      ctx.fill();
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

function paintShapes(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  base: HTMLImageElement | null,
  s: number,
  sampleScale: number,
): void {
  for (const shape of shapes) {
    paintShape(ctx, shape, base, s, sampleScale);
  }
}

function rectFromDrag(a: Point, b: Point): CssRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(
  function AnnotationCanvas(props, ref) {
    const {
      imageWidth,
      imageHeight,
      tool,
      color,
      lineWidth,
      baseImage,
      selection,
      onHistoryChange,
      onRequestReselect,
    } = props;

    const wrapRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [shapes, setShapes] = useState<Shape[]>([]);
    const [redoStack, setRedoStack] = useState<Shape[]>([]);
    const [draft, setDraft] = useState<Shape | null>(null);
    const [textAt, setTextAt] = useState<Point | null>(null);
    const [textValue, setTextValue] = useState("");
    const idRef = useRef(1);
    const numberRef = useRef(1);
    const drawingRef = useRef<{ start: Point; pts: Point[] } | null>(null);
    const shapesRef = useRef<Shape[]>([]);

    useEffect(() => {
      shapesRef.current = shapes;
    }, [shapes]);

    useEffect(() => {
      onHistoryChange?.(shapes.length > 0, redoStack.length > 0);
    }, [shapes, redoStack, onHistoryChange]);

    const addShape = useCallback((shape: Shape) => {
      shapesRef.current = [...shapesRef.current, shape];
      setShapes(shapesRef.current);
      setRedoStack([]);
    }, []);

    const addShapes = useCallback((newShapes: Shape[]) => {
      if (newShapes.length === 0) return;
      shapesRef.current = [...shapesRef.current, ...newShapes];
      setShapes(shapesRef.current);
      setRedoStack([]);
    }, []);

    const undo = useCallback(() => {
      const prev = shapesRef.current;
      if (prev.length === 0) return;
      shapesRef.current = prev.slice(0, -1);
      setShapes(shapesRef.current);
      setRedoStack((r) => [...r, prev[prev.length - 1]]);
    }, []);

    const redo = useCallback(() => {
      setRedoStack((r) => {
        if (r.length === 0) return r;
        const restored = r[r.length - 1];
        shapesRef.current = [...shapesRef.current, restored];
        setShapes(shapesRef.current);
        return r.slice(0, -1);
      });
    }, []);

    const clear = useCallback(() => {
      shapesRef.current = [];
      setShapes([]);
      setRedoStack([]);
      setDraft(null);
      setTextAt(null);
      setTextValue("");
      numberRef.current = 1;
    }, []);

    const exportDataUrl = useCallback((base: HTMLImageElement, scale: number): string => {
      const c = document.createElement("canvas");
      c.width = base.naturalWidth;
      c.height = base.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.drawImage(base, 0, 0);
      paintShapes(ctx, shapesRef.current, base, scale, scale);
      return c.toDataURL("image/png");
    }, []);

    useImperativeHandle(ref, () => ({ undo, redo, clear, exportDataUrl, addShapes }), [
      undo,
      redo,
      clear,
      exportDataUrl,
      addShapes,
    ]);

    // Live redraw (HiDPI-aware; CSS-px coordinate space).
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(imageWidth * dpr));
      canvas.height = Math.max(1, Math.round(imageHeight * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, imageWidth, imageHeight);
      if (selection) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(selection.x, selection.y, selection.w, selection.h);
        ctx.clip();
      }
      const all = draft ? [...shapes, draft] : shapes;
      const sampleScale = baseImage ? baseImage.naturalWidth / imageWidth : 1;
      paintShapes(ctx, all, baseImage, 1, sampleScale);
      if (selection) ctx.restore();
    }, [shapes, draft, selection, baseImage, imageWidth, imageHeight]);

    const localPos = (e: ReactMouseEvent): Point => {
      const r = wrapRef.current?.getBoundingClientRect();
      return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
    };

    const makeDraft = (a: Point, b: Point): Shape | null => {
      const base = { id: -1, color, lineWidth };
      switch (tool) {
        case "rect":
        case "ellipse":
        case "mosaic":
        case "blur": {
          const r = rectFromDrag(a, b);
          return { ...base, kind: tool, ...r };
        }
        case "line":
        case "arrow":
          return { ...base, kind: tool, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        case "pen":
        case "highlighter":
          return { ...base, kind: tool, pts: [a, b] };
        case "balloon": {
          const r = rectFromDrag(a, b);
          return { ...base, kind: "balloon", ...r, tx: a.x, ty: a.y };
        }
        default:
          return null;
      }
    };

    // Debounce rapid number placements (some synthetic clicks fire mousedown
    // twice in quick succession).
    const lastNumberTime = useRef(0);

    const handleMouseDown = (e: ReactMouseEvent) => {
      if (e.button !== 0 || tool === "select") return;
      // Text tool is handled onClick (below). Number tool places on mousedown
      // so drag-style synthetic events work; a real click also fires mousedown.
      if (tool === "text") return;
      const p = localPos(e);
      if (tool === "number") {
        const now = Date.now();
        if (now - lastNumberTime.current < 300) return;
        lastNumberTime.current = now;
        const num = numberRef.current++;
        addShape({ id: idRef.current++, kind: "number", x: p.x, y: p.y, num, color, lineWidth });
        return;
      }
      if (selection && !inRect(p, selection)) {
        onRequestReselect?.();
        return;
      }
      drawingRef.current = { start: p, pts: [p] };
      const d = makeDraft(p, p);
      if (d) setDraft(d);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
      const d = drawingRef.current;
      if (!d || tool === "select" || tool === "text") return;
      const p = localPos(e);
      if (tool === "pen" || tool === "highlighter" || tool === "eraser") {
        d.pts = [...d.pts, p];
        if (tool === "eraser") {
          // Eraser shows a trail but doesn't create a shape.
          setDraft(null);
        } else {
          setDraft({ id: -1, color, lineWidth, kind: tool, pts: d.pts });
        }
      } else {
        const next = makeDraft(d.start, p);
        if (next) setDraft(next);
      }
    };

    /** Check if a point is within `radius` of a shape's geometry. */
    const shapeHitTest = (shape: Shape, p: Point, radius: number): boolean => {
      switch (shape.kind) {
        case "rect":
        case "ellipse":
        case "mosaic":
        case "blur": {
          const x = Math.min(shape.x, shape.x + shape.w) - radius;
          const y = Math.min(shape.y, shape.y + shape.h) - radius;
          const w = Math.abs(shape.w) + radius * 2;
          const h = Math.abs(shape.h) + radius * 2;
          return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
        }
        case "line":
        case "arrow": {
          // Distance from point to line segment.
          const dx = shape.x2 - shape.x1;
          const dy = shape.y2 - shape.y1;
          const lenSq = dx * dx + dy * dy;
          if (lenSq === 0) return Math.hypot(p.x - shape.x1, p.y - shape.y1) <= radius;
          const t = Math.max(0, Math.min(1, ((p.x - shape.x1) * dx + (p.y - shape.y1) * dy) / lenSq));
          const projX = shape.x1 + t * dx;
          const projY = shape.y1 + t * dy;
          return Math.hypot(p.x - projX, p.y - projY) <= radius;
        }
        case "pen":
        case "highlighter":
          return shape.pts.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) <= radius);
        case "text":
        case "number":
          return Math.hypot(shape.x - p.x, shape.y - p.y) <= radius + 12;
        case "balloon": {
          const x = Math.min(shape.x, shape.x + shape.w) - radius;
          const y = Math.min(shape.y, shape.y + shape.h) - radius;
          const w = Math.abs(shape.w) + radius * 2;
          const h = Math.abs(shape.h) + radius * 2;
          return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
        }
      }
    };

    const handleMouseUp = (e: React.MouseEvent) => {
      const d = drawingRef.current;
      drawingRef.current = null;
      setDraft(null);
      if (!d || tool === "select" || tool === "text") return;
      const p = localPos(e);
      // Eraser: delete shapes intersecting the eraser path.
      if (tool === "eraser") {
        const eraserPts = [...d.pts, p];
        const radius = Math.max(10, lineWidth * 2);
        const prev = shapesRef.current;
        const removed: Shape[] = [];
        const kept = prev.filter((s) => {
          const hit = eraserPts.some((pt) => shapeHitTest(s, pt, radius));
          if (hit) removed.push(s);
          return !hit;
        });
        if (removed.length > 0) {
          // Erased shapes go to the redo stack (in original order) so each
          // undo step restores one shape.
          shapesRef.current = kept;
          setShapes(kept);
          setRedoStack((r) => [...r, ...removed]);
        }
        return;
      }
      let shape: Shape | null = null;
      if (tool === "pen" || tool === "highlighter") {
        const pts = [...d.pts, p];
        shape = pts.length >= 2 ? { id: -1, color, lineWidth, kind: tool, pts } : null;
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
        valid = Math.abs(shape.w) >= 20 && Math.abs(shape.h) >= 20;
      }
      if (valid) addShape({ ...shape, id: idRef.current++ });
    };

    const commitText = () => {
      if (textAt && textValue.trim()) {
        addShape({
          id: idRef.current++,
          color,
          lineWidth,
          kind: "text",
          x: textAt.x,
          y: textAt.y,
          text: textValue.trim(),
          fontSize: 16,
        });
      }
      setTextAt(null);
      setTextValue("");
    };

    const interactive = tool !== "select";

    const handleClick = (e: React.MouseEvent) => {
      // Text tool is handled onClick (not mousedown): a drag's mouseup would
      // blur the freshly opened input via onBlur=commitText before it can be used.
      // Number tool also handles click (with shared debounce) for synthetic
      // clicks where mousedown may not fire (e.g. macOS).
      if (tool !== "text" && tool !== "number") return;
      const p = localPos(e);
      if (tool === "text") {
        setTextAt(p);
        setTextValue("");
      } else {
        const now = Date.now();
        if (now - lastNumberTime.current < 300) return;
        lastNumberTime.current = now;
        const num = numberRef.current++;
        addShape({ id: idRef.current++, kind: "number", x: p.x, y: p.y, num, color, lineWidth });
      }
    };

    return (
      <div
        ref={wrapRef}
        data-testid="screenshot-annotation-layer"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: imageWidth,
          height: imageHeight,
          // Above the z-20 region-select interaction layer so draw tools
          // receive pointer events; below the z-50 toolbar.
          zIndex: 30,
          pointerEvents: interactive ? "auto" : "none",
          cursor: interactive ? "crosshair" : "default",
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="screenshot-annotation-canvas"
          style={{ display: "block", width: imageWidth, height: imageHeight }}
        />
        {textAt && (
          <input
            autoFocus
            data-testid="annotation-text-input"
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitText();
              else if (e.key === "Escape") {
                e.stopPropagation();
                setTextAt(null);
                setTextValue("");
              }
            }}
            onBlur={commitText}
            style={{
              position: "absolute",
              left: Math.max(0, textAt.x - 4),
              top: Math.max(0, textAt.y - 22),
              minWidth: 80,
              background: "rgba(0, 0, 0, 0.35)",
              border: "none",
              borderBottom: `2px solid ${color}`,
              outline: "none",
              color,
              fontSize: 16,
              fontFamily: 'Inter, -apple-system, "Segoe UI", sans-serif',
              padding: "2px 6px",
              zIndex: 5,
            }}
          />
        )}
      </div>
    );
  },
);
