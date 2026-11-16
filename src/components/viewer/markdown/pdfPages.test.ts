import { expect, it } from "vitest";
import { DEFAULT_EXPORT_SETTINGS } from "./exportModel";
import { paginatePdf, pdfPageLayout } from "./pdfPages";

it("moves boundaries before text, rows and diagrams without losing any content", () => {
  const result = paginatePdf(250, 100, [{ top: 90, bottom: 110 }, { top: 80, bottom: 95 }, { top: 170, bottom: 190 }]);
  expect(result).toEqual([{ top: 0, bottom: 80 }, { top: 80, bottom: 170 }, { top: 170, bottom: 250 }]);
});
it("allows oversized blocks across pages while preserving their line boundaries", () => {
  expect(paginatePdf(201, 100, [{ top: 0, bottom: 201 }, { top: 95, bottom: 105 }])).toEqual([{ top: 0, bottom: 95 }, { top: 95, bottom: 195 }, { top: 195, bottom: 201 }]);
  expect(() => paginatePdf(20101, 100, [])).toThrow("200-page");
});
it("uses the actual page dimensions, margins and orientation", () => {
  expect(pdfPageLayout(DEFAULT_EXPORT_SETTINGS)).toMatchObject({ width: 210, height: 297, margin: 20 });
  expect(pdfPageLayout({ ...DEFAULT_EXPORT_SETTINGS, paper: "Letter", orientation: "landscape", margins: "wide" })).toMatchObject({ width: 279.4, height: 215.9, margin: 32 });
});
