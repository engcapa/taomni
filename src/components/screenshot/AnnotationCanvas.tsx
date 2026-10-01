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
  | "text"
  | "mosaic"
  | "number";

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
  kind: "rect" | "ellipse" | "mosaic";
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
  kind: "pen";
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

export type Shape = RectLikeShape | LineLikeShape | PenShape | TextShape | NumberShape;

export interface AnnotationCanvasHandle {
  undo: () => void;
  redo: () => void;
  clear: () => void;
  exportDataUrl: (base: HTMLImageElement, scale: number) => string;
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

    useImperativeHandle(ref, () => ({ undo, redo, clear, exportDataUrl }), [
      undo,
      redo,
      clear,
      exportDataUrl,
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
        case "mosaic": {
          const r = rectFromDrag(a, b);
          return { ...base, kind: tool, ...r };
        }
        case "line":
        case "arrow":
          return { ...base, kind: tool, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        case "pen":
          return { ...base, kind: "pen", pts: [a, b] };
        default:
          return null;
      }
    };

    const handleMouseDown = (e: ReactMouseEvent) => {
      if (e.button !== 0 || tool === "select") return;
      // Text tool is handled onClick (below). Number tool places on mousedown
      // so drag-style synthetic events work; a real click also fires mousedown.
      if (tool === "text") return;
      const p = localPos(e);
      if (tool === "number") {
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
      if (tool === "pen") {
        d.pts = [...d.pts, p];
        setDraft({ id: -1, color, lineWidth, kind: "pen", pts: d.pts });
      } else {
        const next = makeDraft(d.start, p);
        if (next) setDraft(next);
      }
    };

    const handleMouseUp = (e: React.MouseEvent) => {
      const d = drawingRef.current;
      drawingRef.current = null;
      setDraft(null);
      if (!d || tool === "select" || tool === "text") return;
      const p = localPos(e);
      let shape: Shape | null = null;
      if (tool === "pen") {
        const pts = [...d.pts, p];
        shape = pts.length >= 2 ? { id: -1, color, lineWidth, kind: "pen", pts } : null;
      } else {
        shape = makeDraft(d.start, p);
      }
      if (!shape) return;
      let valid = false;
      if (shape.kind === "rect" || shape.kind === "ellipse" || shape.kind === "mosaic") {
        valid = shape.w >= 3 && shape.h >= 3;
      } else if (shape.kind === "line" || shape.kind === "arrow") {
        valid = dist({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) >= 5;
      } else if (shape.kind === "pen") {
        valid = shape.pts.length >= 2;
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
      if (tool !== "text") return;
      const p = localPos(e);
      setTextAt(p);
      setTextValue("");
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
