import { describe, expect, it } from "vitest";
import { DEFAULT_EXPORT_SETTINGS } from "./exportModel";
import { svgGeometry, wordImageLayout, wordPageLayout } from "./docxImages";

describe("Word diagram layout and sampling", () => {
  it("uses viewBox instead of percentage image natural dimensions", () => {
    const svg = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width:420px" viewBox="-8 -8 420 120"/>', "image/svg+xml").documentElement;
    expect(svgGeometry(svg)).toEqual({ width: 420, height: 120 });
    const result = wordImageLayout(420, 120, DEFAULT_EXPORT_SETTINGS, true);
    expect(result.width).toBeGreaterThan(600);
    expect(result.pixelWidth / (result.width / 96)).toBeGreaterThanOrEqual(300);
    expect(result.width / result.height).toBeCloseTo(3.5, 1);
  });
  it("sizes against real paper, orientation and margins while keeping tall diagrams inside the page", () => {
    const portrait = wordImageLayout(1000, 200, DEFAULT_EXPORT_SETTINGS, true);
    const landscapeSettings = { ...DEFAULT_EXPORT_SETTINGS, paper: "Letter" as const, orientation: "landscape" as const, margins: "narrow" as const };
    const landscape = wordImageLayout(1000, 200, landscapeSettings, true);
    expect(landscape.width).toBeGreaterThan(portrait.width);
    const tall = wordImageLayout(200, 4000, DEFAULT_EXPORT_SETTINGS, true);
    expect(tall.height).toBeLessThanOrEqual(Math.ceil(wordPageLayout(DEFAULT_EXPORT_SETTINGS).height));
    expect(tall.pixelHeight / (tall.height / 96)).toBeGreaterThanOrEqual(300);
  });
  it("retains original raster samples instead of inventing detail and rejects unsafe images", () => {
    expect(wordImageLayout(24, 16, DEFAULT_EXPORT_SETTINGS, false)).toEqual({ width: 24, height: 16, pixelWidth: 24, pixelHeight: 16 });
    expect(() => wordImageLayout(10000, 10000, DEFAULT_EXPORT_SETTINGS, false)).toThrow("safe Word");
    expect(() => wordImageLayout(0, 4, DEFAULT_EXPORT_SETTINGS, true)).toThrow("geometry");
    const svg = new DOMParser().parseFromString('<svg width="100%" height="100%"/>', "image/svg+xml").documentElement;
    expect(() => svgGeometry(svg)).toThrow("viewBox");
  });
});
