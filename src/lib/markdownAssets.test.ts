import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeMarkdownPath, imageFileName, markdownImage, readMarkdownImage, resolveMarkdownAsset, saveMarkdownImage } from "./markdownAssets";
import { viewerReadBytes, viewerSavePastedImage } from "./viewer";
import { safeImageBlob } from "./imageSafety";

vi.mock("./viewer", () => ({ viewerReadBytes: vi.fn(), viewerSavePastedImage: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe("Markdown image paths and disk ownership", () => {
  it("encodes spaces, Unicode, brackets and Windows separators as portable relative URLs", () => {
    expect(encodeMarkdownPath("assets\\图 1(#).png")).toBe("assets/%E5%9B%BE%201%28%23%29.png");
    expect(markdownImage("a[b]", "assets/图 1.png")).toBe("![a\\[b\\]](assets/%E5%9B%BE%201.png)");
    expect(resolveMarkdownAsset("C:\\notes\\a.md", "assets/%E5%9B%BE%201.png")).toBe("C:/notes/assets/图 1.png");
    expect(resolveMarkdownAsset("/notes/docs/a.md", "../images/a.png")).toBe("/notes/images/a.png");
    expect(resolveMarkdownAsset("C:\\notes\\a.md", "file:///C:/notes/a.png")).toBe("C:/notes/a.png");
  });
  it("never falls back to a direct external request or implicit network filesystem", async () => {
    await expect(readMarkdownImage("/a/doc.md", "https://example.test/image.png")).rejects.toThrow("Remote images");
    await expect(readMarkdownImage("/a/doc.md", "//example.test/image.png")).rejects.toThrow("Network");
    expect(() => resolveMarkdownAsset("/a/doc.md", "file://server/path.png")).toThrow("Remote file");
    expect(viewerReadBytes).not.toHaveBeenCalled();
  });
  it("uses deterministic date/time templates and rejects paths in a filename", () => {
    expect(imageFileName("image-{date}-{time}.jpg", new Date(2026, 10, 13, 14, 25, 30))).toBe("image-20261113-142530.png");
    expect(() => imageFileName("../evil.png")).toThrow("directory");
  });
  it("persists bytes before publishing a link and propagates failures without a dangling link", async () => {
    const blob = { size: 3, type: "image/png", arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer } as Blob;
    vi.mocked(viewerSavePastedImage).mockResolvedValue({ path: "/docs/assets/a b.png", relativePath: "assets/a%20b.png" });
    const saved = await saveMarkdownImage("/docs/test.md", blob, { markdownImageDir: "assets", markdownImageTemplate: "image-{date}.png" });
    expect(saved.markdown).toBe("![image](assets/a%20b.png)");
    expect(viewerSavePastedImage).toHaveBeenCalledWith(expect.objectContaining({ docPath: "/docs/test.md", dir: "assets", bytes: [1, 2, 3] }));
    vi.mocked(viewerSavePastedImage).mockResolvedValue({ path: "/docs/assets/中 %20%.png", relativePath: "assets/%E4%B8%AD%20%2520%25.png" });
    const percent = await saveMarkdownImage("/docs/test.md", blob, { markdownImageDir: "assets", markdownImageTemplate: "image.png" });
    expect(percent.markdown).toBe("![image](assets/%E4%B8%AD%20%2520%25.png)");
    expect(resolveMarkdownAsset("/docs/test.md", "assets/%E4%B8%AD%20%2520%25.png")).toBe("/docs/assets/中 %20%.png");
    vi.mocked(viewerSavePastedImage).mockRejectedValue(new Error("permission denied"));
    await expect(saveMarkdownImage("/docs/test.md", blob, { markdownImageDir: "assets", markdownImageTemplate: "image.png" })).rejects.toThrow("permission denied");
    await expect(saveMarkdownImage("Untitled", blob, { markdownImageDir: "assets", markdownImageTemplate: "image.png" })).rejects.toThrow("Save the document");
  });
  it("shares the offline SVG policy, stripping scripts, CSS and image/animation references", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.test/a);</style><script>alert(1)</script><image href="https://evil.test/img"/><path fill="url(https://evil.test/fill)"/><use href="#shape"/></svg>';
    const blob = safeImageBlob(new TextEncoder().encode(svg), "image/svg+xml", 10240);
    const clean = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
    expect(clean).not.toContain("evil.test"); expect(clean).not.toContain("script"); expect(clean).not.toContain("<use");
  });
  it("reads images with a bounded native call and embeds actual bytes", async () => {
    vi.mocked(viewerReadBytes).mockResolvedValue({ bytes: [1, 2, 3], mime: "image/png", size: 3 });
    expect(await readMarkdownImage("/docs/test.md", "assets/test.png")).toBe("data:image/png;base64,AQID");
    expect(viewerReadBytes).toHaveBeenCalledWith("/docs/assets/test.png", 20 * 1024 * 1024);
  });
});
