import { describe, expect, it, vi } from "vitest";
import { adjustPixels, drawEdited, editedSize, NEUTRAL_ADJUST, paintWatermark, watermarkLayout } from "./screenshotImage";

describe("scattered screenshot watermarks", () => {
  it("covers every quadrant with reproducible jitter, not a bottom-right stamp", () => {
    const a = watermarkLayout(1920, 1080, (size) => size * 7, 42);
    expect(a).toEqual(watermarkLayout(1920, 1080, (size) => size * 7, 42));
    expect(a).not.toEqual(watermarkLayout(1920, 1080, (size) => size * 7, 43));
    const quadrants = new Set(a.marks.map((m) => `${m.x < 960}:${m.y < 540}`));
    expect(quadrants.size).toBe(4);
    expect(a.marks.every((m) => m.x >= 0 && m.x <= 1920 && m.y >= 0 && m.y <= 1080)).toBe(true);
    expect(a.marks.length).toBeLessThan(80);
  });
  it("does not depend on screenshot aspect ratio", () => {
    for (const [width, height] of [[400, 18000], [16000, 200], [20, 10]]) {
      const layout = watermarkLayout(width, height, (size) => size * 5, 88);
      expect(layout.marks.length).toBeGreaterThan(0);
      expect(layout.marks.every((m) => Number.isFinite(m.x + m.y))).toBe(true);
    }
  });
  it("paints with saved alpha and deterministic rotations", () => {
    const ctx = { save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 80 }) } as unknown as CanvasRenderingContext2D;
    paintWatermark(ctx, 900, 600, { text: "internal", opacity: 0.16, color: "#fff", seed: 5 });
    expect(ctx.globalAlpha).toBe(0.16);
    expect(ctx.fillText).toHaveBeenCalledWith("internal", 0, 0);
    expect(vi.mocked(ctx.fillText).mock.calls.length).toBeGreaterThan(4);
    expect(vi.mocked(ctx.restore).mock.calls.length).toBe(vi.mocked(ctx.save).mock.calls.length);
  });
});

describe("basic image edits", () => {
  it("rotates dimensions, clamps crops and rejects unsafe resize dimensions", () => {
    expect(editedSize(300, 500, { kind: "rotate", quarterTurns: 1 })).toEqual({ width: 500, height: 300 });
    expect(editedSize(300, 500, { kind: "rotate", quarterTurns: 2 })).toEqual({ width: 300, height: 500 });
    expect(editedSize(300, 500, { kind: "crop", x: 200, y: 100, width: 300, height: 500 })).toEqual({ width: 100, height: 400 });
    for (const width of [NaN, Infinity, -10, 20000]) expect(() => editedSize(10, 10, { kind: "resize", width, height: 100 })).toThrow();
    expect(() => editedSize(10, 10, { kind: "resize", width: 10000, height: 10000 })).toThrow();
  });
  it("keeps alpha and identity adjustment pixels exactly", () => {
    const px = new Uint8ClampedArray([100, 200, 80, 42, 255, 0, 0, 255]);
    const before = px.slice();
    adjustPixels(px, { kind: "adjust", ...NEUTRAL_ADJUST });
    expect(px).toEqual(before);
    adjustPixels(px, { kind: "adjust", ...NEUTRAL_ADJUST, invert: true });
    expect(px).toEqual(new Uint8ClampedArray([155, 55, 175, 42, 0, 255, 255, 255]));
  });
  it("applies grayscale with identical RGB without disturbing transparency", () => {
    const px = new Uint8ClampedArray([200, 50, 100, 81]);
    adjustPixels(px, { kind: "adjust", ...NEUTRAL_ADJUST, grayscale: true });
    expect(px[0]).toBe(px[1]); expect(px[1]).toBe(px[2]); expect(px[3]).toBe(81);
  });
  it("uses pixel adjustment even if Canvas filter is present (WebKit parity)", () => {
    const pixels = new Uint8ClampedArray([1, 2, 3, 255]);
    const ctx = { save: vi.fn(), restore: vi.fn(), drawImage: vi.fn(), filter: "none", getImageData: vi.fn(() => ({ data: pixels })), putImageData: vi.fn() } as unknown as CanvasRenderingContext2D;
    drawEdited(ctx, {} as CanvasImageSource, 1, 1, { kind: "adjust", ...NEUTRAL_ADJUST, invert: true });
    expect(ctx.putImageData).toHaveBeenCalledOnce(); expect([...pixels]).toEqual([254, 253, 252, 255]);
  });
});
