import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnnotationCanvas,
  commit,
  paintShape,
  redoHistory,
  shapeHitTest,
  shapeBounds,
  transformShape,
  undoHistory,
  type AnnotationCanvasHandle,
  type History,
  type RectLikeShape,
  type Shape,
} from "./AnnotationCanvas";

const rect = (id: number, x: number): Shape => ({ id, kind: "rect", color: "#f00", lineWidth: 2, x, y: 0, w: 10, h: 10 });

describe("annotation manipulation", () => {
  it("selects the middle of a sparse pen segment", () => {
    expect(shapeHitTest({ id: 1, kind: "pen", color: "red", lineWidth: 4, pts: [{ x: 10, y: 20 }, { x: 110, y: 20 }] }, { x: 60, y: 20 }, 5)).toBe(true);
  });

  it("moves and scales strokes without mutating their undo snapshot", () => {
    const pen: Shape = { id: 1, kind: "pen", color: "red", lineWidth: 4, pts: [{ x: 10, y: 20 }, { x: 110, y: 120 }] };
    const moved = transformShape(pen, shapeBounds(pen), { x: 30, y: 40, w: 200, h: 150 });
    expect(moved).toMatchObject({ pts: [{ x: 30, y: 40 }, { x: 230, y: 190 }] });
    expect(pen.pts[0]).toEqual({ x: 10, y: 20 });
  });

  it("moves the balloon tail with its body and preserves line direction", () => {
    const arrow: Shape = { id: 1, kind: "arrow", color: "red", lineWidth: 4, x1: 100, y1: 100, x2: 20, y2: 40 };
    const moved = transformShape(arrow, shapeBounds(arrow), { x: 120, y: 140, w: 80, h: 60 });
    expect(moved).toMatchObject({ x1: 200, y1: 200, x2: 120, y2: 140 });
    const balloon: Shape = { id: 2, kind: "balloon", color: "red", lineWidth: 4, x: 50, y: 50, w: 40, h: 40, tx: 10, ty: 10 };
    expect(transformShape(balloon, shapeBounds(balloon), { x: 20, y: 30, w: 80, h: 80 })).toMatchObject({ x: 60, y: 70, tx: 20, ty: 30 });
  });
});

describe("annotation history", () => {
  const empty: History = { shapes: [], undo: [], redo: [] };

  it("undoes and redoes additions in order", () => {
    let h = commit(empty, [rect(1, 0)]);
    h = commit(h, [...h.shapes, rect(2, 20)]);
    expect(h.shapes.map((s) => s.id)).toEqual([1, 2]);
    h = undoHistory(h);
    expect(h.shapes.map((s) => s.id)).toEqual([1]);
    h = undoHistory(h);
    expect(h.shapes).toEqual([]);
    expect(h.undo).toEqual([]);
    h = redoHistory(redoHistory(h));
    expect(h.shapes.map((s) => s.id)).toEqual([1, 2]);
  });

  it("restores erased shapes in their original order on undo", () => {
    let h = commit(empty, [rect(1, 0), rect(2, 20), rect(3, 40)]);
    // Eraser removes the middle shape.
    h = commit(h, h.shapes.filter((s) => s.id !== 2));
    expect(h.shapes.map((s) => s.id)).toEqual([1, 3]);
    h = undoHistory(h);
    expect(h.shapes.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it("treats a batch (auto-redact) as one undo step", () => {
    let h = commit(empty, [rect(1, 0)]);
    h = commit(h, [...h.shapes, rect(2, 20), rect(3, 40), rect(4, 60)]);
    h = undoHistory(h);
    expect(h.shapes.map((s) => s.id)).toEqual([1]);
  });

  it("drops the redo stack on a new edit", () => {
    let h = commit(empty, [rect(1, 0)]);
    h = undoHistory(h);
    h = commit(h, [rect(5, 0)]);
    expect(h.redo).toEqual([]);
    expect(redoHistory(h)).toBe(h);
  });

  it("is a no-op at the history ends", () => {
    expect(undoHistory(empty)).toBe(empty);
    expect(redoHistory(empty)).toBe(empty);
  });
});

describe("shapeHitTest", () => {
  it("hits rectangles including reversed ones", () => {
    const reversed: Shape = { id: 1, kind: "rect", color: "#f00", lineWidth: 2, x: 50, y: 50, w: -20, h: -20 };
    expect(shapeHitTest(reversed, { x: 40, y: 40 }, 0)).toBe(true);
    expect(shapeHitTest(reversed, { x: 60, y: 60 }, 0)).toBe(false);
  });

  it("measures distance to line segments, not their bounding box", () => {
    const line: Shape = { id: 1, kind: "line", color: "#f00", lineWidth: 2, x1: 0, y1: 0, x2: 100, y2: 100 };
    expect(shapeHitTest(line, { x: 50, y: 52 }, 5)).toBe(true);
    expect(shapeHitTest(line, { x: 90, y: 10 }, 5)).toBe(false);
  });

  it("hits text by its rendered extent", () => {
    const text: Shape = { id: 1, kind: "text", color: "#f00", lineWidth: 2, x: 10, y: 10, text: "hello world", fontSize: 18 };
    expect(shapeHitTest(text, { x: 70, y: 20 }, 2)).toBe(true);
    expect(shapeHitTest(text, { x: 10, y: 60 }, 2)).toBe(false);
  });
});

function contextMock() {
  return {
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    getTransform: vi.fn(() => ({ a: 1 })),
    imageSmoothingEnabled: true,
    filter: "none",
  };
}

const sampledShape = (kind: "mosaic" | "blur"): RectLikeShape => ({
  id: 1, kind, color: "#f00", lineWidth: 2, x: 30, y: 40, w: 50, h: 60,
});

// Argument/transform contracts only: mocked 2D contexts do not prove actual
// pixelation, blur rendering, exported pixels, or native HiDPI behavior.
describe("annotation source sampling", () => {
  let base: HTMLImageElement;
  let contexts: Map<HTMLCanvasElement, ReturnType<typeof contextMock>>;

  beforeEach(() => {
    base = new Image();
    Object.defineProperties(base, {
      naturalWidth: { value: 600 },
      naturalHeight: { value: 400 },
    });
    contexts = new Map();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      if (!contexts.has(this)) contexts.set(this, contextMock());
      return contexts.get(this) as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,unit-contract");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("samples mosaic X and Y independently, without scaling its CSS destination", () => {
    const ctx = contextMock();
    paintShape(ctx as unknown as CanvasRenderingContext2D, sampledShape("mosaic"), base, 2, 3);
    const [tiny, tinyContext] = [...contexts.entries()][0];
    expect(tinyContext.drawImage).toHaveBeenCalledWith(base, 60, 120, 100, 180, 0, 0, 5, 6);
    expect(ctx.drawImage).toHaveBeenCalledWith(tiny, 0, 0, 5, 6, 30, 40, 50, 60);
    expect(tiny.width).toBe(5);
    expect(tiny.height).toBe(6);
    expect(ctx.imageSmoothingEnabled).toBe(false);
  });

  it("samples blur padding independently on each axis and keeps the CSS clip", () => {
    const ctx = contextMock();
    paintShape(ctx as unknown as CanvasRenderingContext2D, sampledShape("blur"), base, 2, 3);
    expect(ctx.rect).toHaveBeenCalledWith(30, 40, 50, 60);
    expect(ctx.clip).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalledWith(base, 28, 72, 164, 276, 14, 24, 82, 92);
  });

  it.each(["mosaic", "blur"] as const)("normalizes reverse-drag %s before sampling both axes", (kind) => {
    const ctx = contextMock();
    const reversed = { ...sampledShape(kind), x: 80, y: 100, w: -50, h: -60 };
    paintShape(ctx as unknown as CanvasRenderingContext2D, reversed, base, 2, 3);
    if (kind === "mosaic") {
      expect([...contexts.values()][0].drawImage).toHaveBeenCalledWith(base, 60, 120, 100, 180, 0, 0, 5, 6);
    } else {
      expect(ctx.drawImage).toHaveBeenCalledWith(base, 28, 72, 164, 276, 14, 24, 82, 92);
    }
  });

  it.each(["mosaic", "blur"] as const)("retains four-argument scalar sampling for %s callers", (kind) => {
    const ctx = contextMock();
    paintShape(ctx as unknown as CanvasRenderingContext2D, sampledShape(kind), base, 2);
    if (kind === "mosaic") {
      expect([...contexts.values()][0].drawImage).toHaveBeenCalledWith(base, 60, 80, 100, 120, 0, 0, 5, 6);
    } else {
      expect(ctx.drawImage).toHaveBeenCalledWith(base, 28, 48, 164, 184, 14, 24, 82, 92);
    }
  });

  it.each(["mosaic", "blur"] as const)("skips %s sampling without a base or for a degenerate rectangle", (kind) => {
    const ctx = contextMock();
    const target = ctx as unknown as CanvasRenderingContext2D;
    paintShape(target, sampledShape(kind), null, 2, 3);
    paintShape(target, { ...sampledShape(kind), w: 0 }, base, 2, 3);
    paintShape(target, { ...sampledShape(kind), h: 0.5 }, base, 2, 3);
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(contexts.size).toBe(0);
  });

  it.each(["mosaic", "blur"] as const)("derives independent natural/display scales for live %s drawing", (kind) => {
    const ref = createRef<AnnotationCanvasHandle>();
    render(createElement(AnnotationCanvas, {
      ref, imageWidth: 300, imageHeight: 100, baseImage: base,
      tool: "select", color: "#f00", lineWidth: 2, selection: null,
    }));
    const canvas = screen.getByTestId("screenshot-annotation-canvas") as HTMLCanvasElement;
    const ctx = contexts.get(canvas)!;
    const dpr = window.devicePixelRatio || 1;
    expect(ctx.setTransform).toHaveBeenLastCalledWith(dpr, 0, 0, dpr, 0, 0);
    act(() => ref.current!.addShapes([sampledShape(kind)]));
    if (kind === "mosaic") {
      const tinyContext = [...contexts.entries()].find(([element]) => element !== canvas)![1];
      expect(tinyContext.drawImage).toHaveBeenCalledWith(base, 60, 160, 100, 240, 0, 0, 5, 6);
    } else {
      expect(ctx.drawImage).toHaveBeenCalledWith(base, 28, 96, 164, 368, 14, 24, 82, 92);
    }
  });

  it.each(["mosaic", "blur"] as const)("passes both export scales to %s source sampling", (kind) => {
    const ref = createRef<AnnotationCanvasHandle>();
    render(createElement(AnnotationCanvas, {
      ref, imageWidth: 300, imageHeight: 100, baseImage: null,
      tool: "select", color: "#f00", lineWidth: 2, selection: null,
    }));
    act(() => ref.current!.addShapes([sampledShape(kind)]));
    contexts.clear();
    expect(ref.current!.exportDataUrl(base, 2, 3)).toBe("data:image/png;base64,unit-contract");
    const [[exportCanvas, exportContext], tiny] = [...contexts.entries()];
    expect(exportCanvas.width).toBe(600);
    expect(exportCanvas.height).toBe(400);
    expect(exportContext.drawImage).toHaveBeenNthCalledWith(1, base, 0, 0);
    expect(exportContext.setTransform).toHaveBeenCalledWith(2, 0, 0, 3, 0, 0);
    if (kind === "mosaic") {
      expect(tiny[1].drawImage).toHaveBeenCalledWith(base, 60, 120, 100, 180, 0, 0, 5, 6);
      expect(exportContext.drawImage).toHaveBeenLastCalledWith(tiny[0], 0, 0, 5, 6, 30, 40, 50, 60);
    } else {
      expect(exportContext.drawImage).toHaveBeenLastCalledWith(base, 28, 72, 164, 276, 14, 24, 82, 92);
    }
  });
});
