import { afterEach, describe, expect, it, vi } from "vitest";
import { paintPdfText, pdfTextClusters } from "./pdfTextLayer";

const box = (left: number, top: number, width: number, height = 20) => new DOMRect(left, top, width, height);
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("searchable PDF text layout", () => {
  it("retains Unicode graphemes and collapsed visible spaces without hidden/duplicate math text", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p>中 café é 😀</p><span style="display:none">secret</span><span class="katex-mathml">duplicate</span><svg><title>title</title><text>图</text></svg>';
    document.body.append(root);
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(box(100, 200, 500, 100));
    let text: Node, start = 0, end = 0;
    vi.spyOn(document, "createRange").mockImplementation(() => ({
      setStart: (node: Node, value: number) => { text = node; start = value; },
      setEnd: (_: Node, value: number) => { end = value; },
      getBoundingClientRect: () => box(100 + start * 8, text.parentElement?.tagName === "text" ? 230 : 200, (end - start) * 8),
    }) as Range);
    const clusters = pdfTextClusters(root);
    expect(clusters.map((item) => item.text)).toEqual(["中", " ", "c", "a", "f", "é", " ", "é", " ", "😀", "图"]);
    expect(clusters.at(-1)).toMatchObject({ left: 0, top: 30, text: "图" });
    expect(clusters.find((item) => item.text === "😀")?.width).toBe(16);
  });

  it("clips overflowing text to its visible ancestor instead of indexing hidden code", () => {
    const root = document.createElement("div"); root.innerHTML = '<pre style="overflow:hidden">abc</pre>';
    document.body.append(root);
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(box(0, 0, 100));
    vi.spyOn(root.firstElementChild!, "getBoundingClientRect").mockReturnValue(box(0, 0, 15));
    let start = 0;
    vi.spyOn(document, "createRange").mockImplementation(() => ({
      setStart: (_: Node, value: number) => { start = value; }, setEnd: () => {},
      getBoundingClientRect: () => box(start * 10, 0, 10),
    }) as unknown as Range);
    expect(pdfTextClusters(root)).toEqual([
      { text: "a", left: 0, top: 0, width: 10, height: 20 },
      { text: "b", left: 10, top: 0, width: 5, height: 20 },
    ]);
  });

  it("places each grapheme on exactly one page with CSS pixel to PDF point conversion", () => {
    const font = { write: vi.fn() };
    const text = [
      { text: "第一页", left: 10, top: 20, width: 30, height: 20 },
      { text: "边界", left: 10, top: 90, width: 30, height: 20 },
      { text: "第二页", left: 10, top: 130, width: 30, height: 20 },
      { text: "outside", left: 500, top: 20, width: 30, height: 20 },
    ];
    const page = { pixelHeight: 400, inset: 20, contentWidth: 200 };
    paintPdfText(font, text, page, { top: 0, bottom: 100 });
    expect(font.write.mock.calls).toEqual([["第一页", 22.5, 45, 22.5, 15, 300]]);
    font.write.mockClear();
    paintPdfText(font, text, page, { top: 100, bottom: 200 });
    expect(font.write.mock.calls).toEqual([
      ["边界", 22.5, 22.5, 22.5, 15, 300], ["第二页", 22.5, 52.5, 22.5, 15, 300],
    ]);
  });
});
