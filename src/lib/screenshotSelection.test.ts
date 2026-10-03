import { describe, expect, it, vi } from "vitest";
import { contourBounds, contourPath, maskContour, pointInContour, transformContour, validContour } from "./screenshotSelection";

const concave = [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 60 }, { x: 50, y: 60 }, { x: 50, y: 120 }, { x: 10, y: 120 }];

describe("freehand screenshot selection", () => {
  it("derives a box without turning a concave contour into a rectangle", () => {
    expect(contourBounds(concave)).toEqual({ x: 10, y: 20, w: 100, h: 100 });
    expect(pointInContour({ x: 30, y: 100 }, concave)).toBe(true);
    expect(pointInContour({ x: 90, y: 100 }, concave)).toBe(false);
    expect(pointInContour({ x: 50, y: 100 }, concave)).toBe(true);
    expect(pointInContour({ x: 50, y: 10 }, concave)).toBe(false);
    expect(contourPath(concave)).toBe("M 10 20 L 110 20 L 110 60 L 50 60 L 50 120 L 10 120 Z");
  });

  it("rejects clicks, lines, retraces, tiny and nonfinite gestures but allows crossed lobes", () => {
    expect(validContour(concave)).toBe(true);
    expect(validContour([{ x: 0, y: 0 }, { x: 400, y: 400 }, { x: 200, y: 200 }])).toBe(false);
    expect(validContour([...concave, ...[...concave].reverse()])).toBe(false);
    expect(validContour([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }])).toBe(false);
    expect(validContour([{ x: 0, y: 0 }, { x: 100, y: 100 }])).toBe(false);
    expect(validContour([{ x: NaN, y: 0 }, ...concave])).toBe(false);
    expect(contourBounds([])).toBeNull();
    const crossed = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }];
    expect(validContour(crossed)).toBe(true);
    expect(pointInContour({ x: 50, y: 10 }, crossed)).toBe(true);
    expect(pointInContour({ x: 10, y: 50 }, crossed)).toBe(false);
  });

  it("rejects long diagonals with OS integer-coordinate staircases despite their accumulated area", () => {
    const jittered = [{ x: 100, y: 100 }, { x: 150, y: 137 }, { x: 200, y: 175 },
      { x: 250, y: 212 }, { x: 300, y: 250 }, { x: 350, y: 287 },
      { x: 400, y: 325 }, { x: 450, y: 362 }, { x: 500, y: 400 }];
    expect(validContour(jittered)).toBe(false);
    expect(validContour(jittered.map((p) => ({ x: 1000 - p.x, y: p.y })))).toBe(false);
    expect(validContour([...jittered, ...[...jittered].reverse()])).toBe(false);
    // A narrow but genuinely enclosed triangle must not be mistaken for jitter.
    expect(validContour([{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 44, y: 56 }])).toBe(true);
  });

  it("moves and independently rescales a contour with its bounding box", () => {
    const from = contourBounds(concave)!;
    const changed = transformContour(concave, from, { x: 40, y: 50, w: 200, h: 50 });
    expect(changed[3]).toEqual({ x: 120, y: 70 });
    expect(contourBounds(changed)).toEqual({ x: 40, y: 50, w: 200, h: 50 });
    expect(concave[3]).toEqual({ x: 50, y: 60 });
  });

  it("masks the final crop with per-axis physical coordinates and the even-odd rule", () => {
    const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), globalCompositeOperation: "source-over" };
    maskContour(ctx as unknown as CanvasRenderingContext2D, concave, 2, 1.5, { x: 20, y: 30 });
    expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
    expect(ctx.lineTo).toHaveBeenCalledWith(80, 60);
    expect(ctx.globalCompositeOperation).toBe("destination-in");
    expect(ctx.fill).toHaveBeenCalledWith("evenodd");
    expect(ctx.closePath).toHaveBeenCalledOnce();
    expect(ctx.restore).toHaveBeenCalledOnce();
  });
});
