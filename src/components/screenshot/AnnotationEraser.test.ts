import { describe, expect, it, vi } from "vitest";
import { eraseShapes, transformShape, shapeBounds, commit, undoHistory, redoHistory, paintShape, type Shape } from "./AnnotationCanvas";

const stroke: Shape = { id: 1, kind: "pen", color: "#f00", lineWidth: 4,
  pts: [{ x: 20, y: 80 }, { x: 50, y: 10 }, { x: 80, y: 80 }, { x: 70, y: 55 }, { x: 30, y: 55 }] };

describe("partial annotation erasing", () => {
  it("erases an A's overshoot without deleting the A or mutating its geometry", () => {
    const before = [stroke];
    const after = eraseShapes(before, [{ x: 40, y: 9 }, { x: 60, y: 9 }], 8);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: "pen", pts: stroke.pts, erase: [{ width: 16 }] });
    expect(stroke.erase).toBeUndefined();
    const committed = commit({ shapes: before, undo: [], redo: [] }, [...after]);
    expect(undoHistory(committed).shapes).toEqual(before);
    expect(redoHistory(undoHistory(committed)).shapes).toEqual(after);
  });
  it("no-op erases do not create history, but wider passes can extend an existing hole", () => {
    expect(eraseShapes([stroke], [{ x: 300, y: 300 }], 6)[0]).toBe(stroke);
    const once = eraseShapes([stroke], [{ x: 50, y: 10 }], 6);
    expect(eraseShapes(once, [{ x: 50, y: 10 }], 6)).toBe(once);
    const wider = eraseShapes(once, [{ x: 50, y: 10 }], 10);
    expect(wider[0].erase).toHaveLength(2);
  });
  it("does not erase empty rectangle interiors and interpolates fast sparse drags", () => {
    const rect: Shape = { id: 2, kind: "rect", color: "red", lineWidth: 2, x: 0, y: 0, w: 100, h: 100 };
    const original = [rect];
    expect(eraseShapes(original, [{ x: 50, y: 50 }], 6)).toBe(original);
    expect(eraseShapes(original, [{ x: -20, y: 50 }, { x: 120, y: 50 }], 6)[0].erase).toHaveLength(1);
  });
  it("transforms removed pixels along with the edited shape", () => {
    const erased = eraseShapes([stroke], [{ x: 50, y: 10 }], 8)[0];
    const bounds = shapeBounds(erased);
    const transformed = transformShape(erased, bounds, { x: bounds.x + 100, y: bounds.y + 100, w: bounds.w * 2, h: bounds.h * 2 });
    expect(transformed.erase?.[0].width).toBe(32);
    expect(transformed.erase?.[0].pts[0]).toEqual({ x: 180, y: 110 });
    expect(erased.erase?.[0].pts[0]).toEqual({ x: 50, y: 10 });
  });
  it("drops entirely erased strokes", () => {
    const line: Shape = { id: 3, kind: "line", color: "red", lineWidth: 2, x1: 0, y1: 0, x2: 20, y2: 0 };
    expect(eraseShapes([line], [{ x: -5, y: 0 }, { x: 25, y: 0 }], 6)).toHaveLength(0);
  });
});

describe("solid shapes", () => {
  it("renders filled rectangles, ellipses and closed freehand paths", () => {
    const ctx = { save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), beginPath: vi.fn(), ellipse: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn() } as unknown as CanvasRenderingContext2D;
    paintShape(ctx, { id: 2, kind: "rect", color: "#00f", lineWidth: 4, filled: true, x: 10, y: 10, w: 40, h: 20 }, null, 1);
    expect(ctx.fillRect).toHaveBeenCalledWith(10, 10, 40, 20); expect(ctx.strokeRect).not.toHaveBeenCalled();
    paintShape(ctx, { id: 3, kind: "ellipse", color: "#00f", lineWidth: 4, filled: true, x: 10, y: 10, w: 40, h: 40 }, null, 1);
    expect(ctx.fill).toHaveBeenCalled();
    paintShape(ctx, { ...stroke, filled: true } as Shape, null, 1);
    expect(ctx.closePath).toHaveBeenCalled(); expect(ctx.fill).toHaveBeenCalledWith("evenodd");
  });
});
