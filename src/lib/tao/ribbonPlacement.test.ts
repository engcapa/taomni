import { describe, expect, it } from "vitest";
import {
  clampOffsetRatio,
  nearestEdge,
  normalizePlacement,
  offsetRatioForEdge,
  placementFromPoint,
  ribbonPositionStyle,
} from "./ribbonPlacement";

describe("ribbonPlacement", () => {
  describe("nearestEdge", () => {
    it.each([
      ["left", 4, 300],
      ["right", 796, 300],
      ["top", 400, 4],
      ["bottom", 400, 596],
    ] as const)("picks the %s edge", (expected, x, y) => {
      expect(nearestEdge(x, y, 800, 600)).toBe(expected);
    });
  });

  describe("clampOffsetRatio", () => {
    it("keeps side-edge ratios within [0.12, 0.88]", () => {
      expect(clampOffsetRatio("left", 0)).toBe(0.12);
      expect(clampOffsetRatio("left", 1)).toBe(0.88);
      expect(clampOffsetRatio("right", 0.5)).toBe(0.5);
    });

    it("keeps the top edge clear of both corners", () => {
      expect(clampOffsetRatio("top", 0)).toBe(0.2);
      expect(clampOffsetRatio("top", 1)).toBe(0.8);
    });

    it("keeps the bottom edge clear of the resize handle", () => {
      expect(clampOffsetRatio("bottom", 1)).toBe(0.82);
    });

    it("falls back to the band midpoint for non-finite input", () => {
      expect(clampOffsetRatio("left", NaN)).toBeCloseTo(0.5, 5);
    });
  });

  describe("offsetRatioForEdge", () => {
    it("projects vertically for side edges", () => {
      expect(offsetRatioForEdge("left", 0, 300, 800, 600)).toBeCloseTo(0.5, 5);
    });
    it("projects horizontally for top/bottom edges and clamps", () => {
      // x=0 → raw 0 → clamped to the top edge minimum 0.2.
      expect(offsetRatioForEdge("top", 0, 0, 800, 600)).toBe(0.2);
      expect(offsetRatioForEdge("bottom", 400, 600, 800, 600)).toBeCloseTo(0.5, 5);
    });
  });

  describe("placementFromPoint", () => {
    it("combines nearest edge with a clamped offset", () => {
      const p = placementFromPoint(4, 300, 800, 600);
      expect(p.edge).toBe("left");
      expect(p.offsetRatio).toBeCloseTo(0.5, 5);
    });
    it("clamps offsets near corners away from window controls", () => {
      const p = placementFromPoint(10, 10, 800, 600); // near top-left corner
      // Nearest edge is a side or top; whichever, the offset must be clamped.
      const bounds: Record<string, [number, number]> = {
        top: [0.2, 0.8],
        left: [0.12, 0.88],
        right: [0.12, 0.88],
        bottom: [0.1, 0.82],
      };
      const [min, max] = bounds[p.edge];
      expect(p.offsetRatio).toBeGreaterThanOrEqual(min);
      expect(p.offsetRatio).toBeLessThanOrEqual(max);
    });
  });

  describe("ribbonPositionStyle", () => {
    it("anchors to the correct edge with a percentage offset", () => {
      expect(ribbonPositionStyle({ edge: "left", offsetRatio: 0.5 })).toMatchObject({
        left: 0,
        transform: "translateY(-50%)",
      });
      expect(ribbonPositionStyle({ edge: "bottom", offsetRatio: 0.5 })).toMatchObject({
        bottom: 0,
        transform: "translateX(-50%)",
      });
    });
  });

  describe("normalizePlacement", () => {
    it("repairs invalid stored placements", () => {
      expect(normalizePlacement(null)).toEqual({ edge: "right", offsetRatio: 0.5 });
      expect(normalizePlacement({ edge: "top", offsetRatio: 5 })).toEqual({ edge: "top", offsetRatio: 0.8 });
    });
  });
});
