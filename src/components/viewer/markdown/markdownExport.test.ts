import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMarkdownExport, DEFAULT_EXPORT_SETTINGS, markdownExportCss } from "./exportModel";
import { exportMarkdown } from "./markdownExport";
import { readMarkdownImage } from "../../../lib/markdownAssets";
import { saveExportBlob } from "./exportFiles";

vi.mock("../../../lib/markdownAssets", async (original) => ({ ...await original<typeof import("../../../lib/markdownAssets")>(), readMarkdownImage: vi.fn() }));
vi.mock("./exportFiles", () => ({ saveExportBlob: vi.fn(), exportMarkdownFolder: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readMarkdownImage).mockResolvedValue("data:image/png;base64,AQID");
  vi.mocked(saveExportBlob).mockResolvedValue("/out/doc.html");
});

describe("self-contained sanitized Markdown output", () => {
  it("shares the existing renderer and embeds actual local image data with no resource fetch", async () => {
    const source = '# Doc\n\n**bold** ![local](assets/a.png)\n\n<script>alert(1)</script>\n';
    const result = await prepareMarkdownExport(source, "/docs/a.md", DEFAULT_EXPORT_SETTINGS);
    expect(result.html).toContain('src="data:image/png;base64,AQID"');
    expect(result.html).toContain("<strong>bold</strong>");
    expect(result.html).toContain("Content-Security-Policy");
    expect(result.html).toContain("img-src data:");
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain('src="assets/');
    expect(result.html).toContain('aria-label="Table of contents"');
    expect(readMarkdownImage).toHaveBeenCalledWith("/docs/a.md", "assets/a.png");
    expect(source).toContain("<script>alert(1)</script>");
  });
  it("fails rather than publishing an HTML file with missing images", async () => {
    vi.mocked(readMarkdownImage).mockRejectedValue(new Error("permission denied"));
    await expect(exportMarkdown("html", "![x](assets/a.png)", "/docs/a.md", DEFAULT_EXPORT_SETTINGS)).rejects.toThrow("permission denied");
    expect(saveExportBlob).not.toHaveBeenCalled();
  });
  it("renders Mermaid, KaTeX math and highlighted fenced code into export HTML", async () => {
    const result = await prepareMarkdownExport("Inline $x^2$ and $$\\frac{1}{2}$$.\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n```rust\nfn main() {}\n```", "/docs/a.md", DEFAULT_EXPORT_SETTINGS);
    expect(result.root.querySelector(".fv-md-mermaid svg")).not.toBeNull();
    expect(result.root.querySelectorAll(".fv-md-math .katex")).toHaveLength(2);
    expect(result.root.querySelector("pre code .tok-keyword")).not.toBeNull();
    expect(result.html).toContain("katex");
    expect(result.html).not.toContain("language-mermaid");
  });
  it("applies actual page CSS, header/page counters and inclusion switches", async () => {
    const settings = { ...DEFAULT_EXPORT_SETTINGS, paper: "Letter" as const, orientation: "landscape" as const, margins: "wide" as const, fileHeader: true, toc: false, highlight: false };
    const css = markdownExportCss(settings, 'a".md');
    expect(css).toContain("size:Letter landscape;margin:32mm");
    expect(css).toContain("@top-center"); expect(css).toContain("counter(page)");
    const output = await prepareMarkdownExport("# Title\n\n```js\nconst x = 1;\n```", "/a.md", settings);
    expect(output.root.querySelector("nav")).toBeNull(); expect(output.root.querySelector("pre code span")).toBeNull();
  });
  it("writes both rich clipboard flavors and reports unsupported capability instead of success", async () => {
    const write = vi.fn(async (_items: unknown[]) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    class Item { constructor(readonly flavors: Record<string, Blob>) {} }
    vi.stubGlobal("ClipboardItem", Item);
    const result = await exportMarkdown("richtext", "# Title\n\nText", "/a.md", DEFAULT_EXPORT_SETTINGS);
    expect(result.status).toBe("copied");
    const item = write.mock.calls[0]?.[0] as unknown as Item[];
    expect(Object.keys(item[0].flavors)).toEqual(["text/html", "text/plain"]);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {} });
    await expect(exportMarkdown("richtext", "a", "/a.md", DEFAULT_EXPORT_SETTINGS)).rejects.toThrow("unavailable");
    vi.unstubAllGlobals();
  });
});
