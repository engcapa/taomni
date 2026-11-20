import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMarkdownExport, DEFAULT_EXPORT_SETTINGS, markdownExportCss } from "./exportModel";
import { exportMarkdown } from "./markdownExport";
import { readMarkdownImage } from "../../../lib/markdownAssets";
import { saveExportBlob } from "./exportFiles";
import { markdownPdf } from "./exportPdf";
import { renderMermaid } from "../../editor/workspace/model/mermaid";

vi.mock("../../../lib/markdownAssets", async (original) => ({ ...await original<typeof import("../../../lib/markdownAssets")>(), readMarkdownImage: vi.fn() }));
vi.mock("./exportFiles", () => ({ saveExportBlob: vi.fn(), exportMarkdownFolder: vi.fn() }));
vi.mock("./exportPdf", () => ({ markdownPdf: vi.fn() }));
vi.mock("../../editor/workspace/model/mermaid", async (original) => {
  const actual = await original<typeof import("../../editor/workspace/model/mermaid")>();
  return { ...actual, renderMermaid: vi.fn(actual.renderMermaid) };
});
vi.mock("./mathExportCss", () => ({ mathExportCss: async () => ".katex{font-family:KaTeX_Main}" }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readMarkdownImage).mockResolvedValue("data:image/png;base64,AQID");
  vi.mocked(saveExportBlob).mockResolvedValue("/out/doc.html");
});

describe("self-contained sanitized Markdown output", () => {
  it("saves independently generated PDF bytes through the normal chooser without invoking printing", async () => {
    const blob = new Blob(["%PDF-1.7\n"], { type: "application/pdf" });
    vi.mocked(markdownPdf).mockResolvedValue(blob);
    vi.mocked(saveExportBlob).mockImplementationOnce(async (_name, output) => {
      expect(await (typeof output === "function" ? output() : output)).toBe(blob);
      return "/out/a.pdf";
    }).mockResolvedValueOnce(null);
    expect(await exportMarkdown("pdf", "# PDF", "/docs/a.md", DEFAULT_EXPORT_SETTINGS)).toEqual({ status: "saved", path: "/out/a.pdf" });
    expect(saveExportBlob).toHaveBeenCalledWith("a.pdf", expect.any(Function), "/docs/a.md");
    expect(markdownPdf).toHaveBeenCalledOnce();
    expect(document.querySelector("iframe")).toBeNull();
    expect(await exportMarkdown("pdf", "# PDF", "/docs/a.md", DEFAULT_EXPORT_SETTINGS)).toEqual({ status: "cancelled" });
    expect(markdownPdf).toHaveBeenCalledOnce();
  });
  it("shares the existing renderer and embeds actual local image data with no resource fetch", async () => {
    const source = '# Doc\n\n**bold** ![local](assets/a.png)\n\n<script>alert(1)</script>\n';
    const result = await prepareMarkdownExport(source, "/docs/a.md", DEFAULT_EXPORT_SETTINGS);
    expect(result.html).toContain('src="data:image/png;base64,AQID"');
    expect(result.html).toContain("<strong>bold</strong>");
    expect(result.html).toContain("Content-Security-Policy");
    expect(result.html).toContain("img-src data:");
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain('src="assets/');
    expect(result.html).not.toContain('aria-label="Table of contents"');
    expect(readMarkdownImage).toHaveBeenCalledWith("/docs/a.md", "assets/a.png");
    expect(source).toContain("<script>alert(1)</script>");
  });
  it("generates a linked TOC only when explicitly enabled without deleting author content", async () => {
    const content = "# Title\n\nAuthor contents: [Details](#details)\n\n## Details\n";
    const result = await prepareMarkdownExport(content, "/docs/a.md", { ...DEFAULT_EXPORT_SETTINGS, toc: true });
    expect(result.root.querySelector("nav")?.getAttribute("aria-label")).toBe("Table of contents");
    expect(result.root.querySelector("nav a")?.getAttribute("href")).toBe("#heading-1");
    expect(result.root.textContent).toContain("Author contents");
    expect(content).toContain("[Details](#details)");
  });
  it("publishes HTML with an accessible placeholder instead of aborting on a missing image", async () => {
    vi.mocked(readMarkdownImage).mockRejectedValue(new Error("permission denied"));
    const prepared = await prepareMarkdownExport("# Keep me\n\n![x](assets/a.png)", "/docs/a.md", DEFAULT_EXPORT_SETTINGS);
    const placeholder = prepared.root.querySelector<HTMLElement>('[data-testid="markdown-render-placeholder"]');
    expect(placeholder).toHaveAttribute("data-kind", "image");
    expect(placeholder).toHaveAttribute("role", "note");
    expect(placeholder).toHaveTextContent("Image unavailable");
    expect(placeholder).toHaveTextContent("assets/a.png");
    expect(placeholder).toHaveAttribute("title", "permission denied");
    expect(prepared.root.querySelector("img")).toBeNull();
    expect(prepared.root.textContent).toContain("Keep me");

    await expect(exportMarkdown("html", "![x](assets/a.png)", "/docs/a.md", DEFAULT_EXPORT_SETTINGS)).resolves.toEqual({ status: "saved", path: "/out/doc.html" });
    expect(saveExportBlob).toHaveBeenCalledOnce();
  });
  it("retains readable images and text when only one referenced image is missing", async () => {
    vi.mocked(readMarkdownImage).mockImplementation(async (_doc, reference) => {
      if (reference.includes("missing")) throw new Error("ENOENT: missing-image.png");
      return "data:image/png;base64,AQID";
    });
    const result = await prepareMarkdownExport(
      "Before\n\n![ok](assets/present.png)\n\n![gone](assets/missing.png)\n\nAfter",
      "/docs/a.md",
      DEFAULT_EXPORT_SETTINGS,
    );
    expect(result.root.querySelectorAll("img")).toHaveLength(1);
    expect(result.root.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AQID");
    expect(result.root.querySelectorAll('[data-kind="image"]')).toHaveLength(1);
    expect(result.root.textContent).toContain("Before");
    expect(result.root.textContent).toContain("After");
    expect(result.root.querySelector('[data-kind="image"]')).toHaveAttribute("title", "ENOENT: missing-image.png");
  });
  it("replaces missing raw HTML image references without fetching or emitting a broken img", async () => {
    vi.mocked(readMarkdownImage).mockRejectedValue(new Error("ENOENT: ./img/header.png"));
    const result = await prepareMarkdownExport(
      '<p align="center"><img src="./img/header.png" alt="Mermaid header"></p>\n\nRemaining text.',
      "/docs/mermaid-readme.md",
      DEFAULT_EXPORT_SETTINGS,
    );
    const placeholder = result.root.querySelector(".fv-md-render-placeholder-image");
    expect(placeholder).toHaveTextContent("Mermaid header");
    expect(placeholder).toHaveTextContent("./img/header.png");
    expect(result.root.querySelector("img")).toBeNull();
    expect(result.root.textContent).toContain("Remaining text.");
    expect(result.html).not.toContain('src="./img/header.png"');
  });
  it("uses the same non-throwing fallback for invalid Mermaid and draw.io blocks", async () => {
    vi.mocked(renderMermaid).mockRejectedValueOnce(new Error("Invalid Mermaid source"));
    const source = "# Diagrams\n\n```mermaid\nflowchart LR\nA --> [\n```\n\n```drawio\n<mxfile>not valid</mxfile>\n```\n\nReadable tail.";
    const result = await prepareMarkdownExport(source, "/docs/a.md", DEFAULT_EXPORT_SETTINGS);
    expect(result.root.querySelectorAll('[data-kind="mermaid"]')).toHaveLength(1);
    expect(result.root.querySelectorAll('[data-kind="drawio"]')).toHaveLength(1);
    expect(result.root.textContent).toContain("Readable tail.");
    expect(result.root.textContent).not.toContain("A -->");
    expect(result.html).toContain("Mermaid diagram unavailable");
    expect(result.html).not.toContain("undefined");
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
