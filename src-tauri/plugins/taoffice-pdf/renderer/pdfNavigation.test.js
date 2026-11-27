import { describe, expect, it, vi } from "vitest";
import { findPdfPages, outlineEntries, outlinePage } from "./pdfNavigation.js";

describe("PDF navigation", () => {
  it("finds matching pages across text runs and line breaks", async () => {
    const getPage = vi.fn(async (number) => ({
      getTextContent: async () => ({ items: number === 2
        ? [{ str: "Revenue", hasEOL: true }, { str: " By region" }]
        : [{ str: "Quarterly report" }] }),
    }));
    const pdf = { numPages: 2, getPage };
    await expect(findPdfPages(pdf, " REVENUE   by region ", new AbortController().signal)).resolves.toEqual([2]);
    const cancelled = AbortSignal.abort();
    await expect(findPdfPages(pdf, "Revenue", cancelled)).rejects.toMatchObject({ name: "AbortError" });
    expect(getPage).toHaveBeenCalledTimes(2);
  });

  it("shows internal destinations with depth and resolves named references", async () => {
    const reference = { num: 52, gen: 0 };
    const nodes = [{ title: "External", url: "https://example.test/", items: [
      { title: "Summary", dest: "Summary" },
    ] }];
    expect(outlineEntries(nodes)).toEqual([{ title: "Summary", destination: "Summary", depth: 1 }]);
    const pdf = { numPages: 3, getDestination: vi.fn().mockResolvedValue([reference]), getPageIndex: vi.fn().mockResolvedValue(2) };
    await expect(outlinePage(pdf, "Summary")).resolves.toBe(3);
    expect(pdf.getPageIndex).toHaveBeenCalledWith(reference);
    await expect(outlinePage(pdf, [0])).resolves.toBe(1);
    await expect(outlinePage(pdf, [5])).rejects.toThrow("outside the document");
  });
});
