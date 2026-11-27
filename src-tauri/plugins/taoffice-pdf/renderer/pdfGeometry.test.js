import { describe, expect, it } from "vitest";
import { canvasScale, fitPageScale, MAX_CANVAS_PIXELS, pageNumber, stepPageScale } from "./pdfGeometry.js";

describe("PDF page controls", () => {
  it("accepts only an integer page inside the loaded document", () => {
    expect(pageNumber(" 02 ", 2)).toBe(2);
    for (const invalid of ["", "-1", "0", "3", "2.0", "2e0", "9999999999999999999"]) {
      expect(pageNumber(invalid, 2)).toBeNull();
    }
  });

  it("zooms monotonically from the actual fitted scale and clamps both limits", () => {
    expect(stepPageScale(1.5, 1)).toBe(1.875);
    expect(stepPageScale(1.5, -1)).toBe(1.2);
    expect(stepPageScale(3.8, 1)).toBe(4);
    expect(stepPageScale(0.22, -1)).toBe(0.2);
  });

  it("fits the viewport while bounding the backing canvas in both dimensions", () => {
    expect(fitPageScale(400, 432)).toBe(1);
    expect(fitPageScale(400, 2000)).toBe(1.5);
    expect(canvasScale(400, 300, 2)).toBe(2);
    expect(canvasScale(20_000, 100, 2) * 20_000).toBeLessThanOrEqual(8192);
    const factor = canvasScale(6000, 6000, 2);
    expect((factor * 6000) ** 2).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 0.001);
  });
});
