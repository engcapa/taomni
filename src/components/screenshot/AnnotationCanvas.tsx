import type { MouseEvent as ReactMouseEvent } from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { pointInContour, traceContour } from "../../lib/screenshotSelection";
import { eraseShapes, eraserRadius } from "./annotation/eraser";
import {
  FONT_STACK,
  TEXT_FONT_SIZE,
  TEXT_LINE_HEIGHT,
  dist,
  inRect,
  midpoint,
  rectFromDrag,
  shapeBounds,
  shapeHitTest,
  textBounds,
  transformShape,
} from "./annotation/geometry";
import { EMPTY_HISTORY, type History, commit, redoHistory, undoHistory } from "./annotation/history";
import { paintPolyline, paintShape } from "./annotation/painting";
import {
  type AnnotationCanvasHandle,
  type AnnotationCanvasProps,
  type CssRect,
  FILLABLE_TOOLS,
  type Point,
  type Shape,
  type ShapeStyle,
  type TextShape,
} from "./annotation/types";

/** Scratch layer for shapes with erase masks (painting is sequential). */

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(
  function AnnotationCanvas(props, ref) {
    const {
      imageWidth,
      imageHeight,
      tool,
      color,
      lineWidth,
      fontFamily = FONT_STACK,
      fontSize = TEXT_FONT_SIZE,
      textHint,
      baseImage,
      selection,
      selectionContour,
      onHistoryChange,
      onRequestReselect,
      fill = false,
      eraserMode = "partial",
    } = props;
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
    const movingRef = useRef<{ shape: Shape; start: Point; bounds: CssRect; corner?: "nw" | "ne" | "sw" | "se"; } | null>(null);
    const idRef = useRef(1);
    const drawingRef = useRef<{ start: Point; pts: Point[]; } | null>(null);
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
      () => ({
        undo, redo, clear, exportDataUrl, addShapes, deleteSelected, updateSelectedStyle, restore,
        snapshot: () => historyRef.current.shapes, shapeCount: () => historyRef.current.shapes.length
      }),
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

    const localPos = (e: { clientX: number; clientY: number; }): Point => {
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
          const opposite = {
            x: move.corner.endsWith("w") ? move.bounds.x + move.bounds.w : move.bounds.x,
            y: move.corner.startsWith("n") ? move.bounds.y + move.bounds.h : move.bounds.y
          };
          bounds = rectFromDrag(opposite, p);
          if (bounds.w < 4 || bounds.h < 4) return;
        } else {
          const clip = selection ?? { x: 0, y: 0, w: imageWidth, h: imageHeight };
          bounds = {
            ...move.bounds,
            x: Math.max(clip.x, Math.min(move.bounds.x + p.x - move.start.x, clip.x + clip.w - move.bounds.w)),
            y: Math.max(clip.y, Math.min(move.bounds.y + p.y - move.start.y, clip.y + clip.h - move.bounds.h))
          };
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

    const finishDrawing = (e: { clientX: number; clientY: number; shiftKey?: boolean; }) => {
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
              width: Math.max(120, Math.min(imageWidth - textAt.x, textBounds({
                id: -1, kind: "text", x: 0, y: 0, text: textValue + "  ", color, lineWidth,
                fontSize: editingTextRef.current?.fontSize ?? fontSize, fontFamily: editingTextRef.current?.fontFamily ?? fontFamily
              }).w + 12)),
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

export {
  FILLABLE_TOOLS,
  type AnnotationCanvasHandle,
  type AnnotationTool,
  type BalloonShape,
  type CssRect,
  type EraseStroke,
  type EraserMode,
  type LineLikeShape,
  type NumberShape,
  type PenShape,
  type RectLikeShape,
  type Shape,
  type ShapeStyle,
  type TextShape,
} from "./annotation/types";

export { FONT_STACK, distToPath, resamplePath, shapeBounds, shapeHitTest, transformShape } from "./annotation/geometry";

export { paintShape } from "./annotation/painting";

export { eraseShapes, eraserRadius } from "./annotation/eraser";

export { commit, redoHistory, undoHistory, type History } from "./annotation/history";
