import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportMarkdownFolder, markdownImageReferences, planMarkdownFolder, saveExportBlob, writeExportBytes } from "./exportFiles";
import { readMarkdownImage } from "../../../lib/markdownAssets";
import { explorerCanonicalPath, localCreateEntry } from "../../../lib/explorer";
import { selectSaveDirectory, selectSaveFilePath, writeStreamAbort, writeStreamAppend, writeStreamClose, writeStreamOpen } from "../../../lib/ipc";
import { sftpMkdir } from "../../../lib/sftp";
import { isTauriRuntime } from "../../../lib/runtime";

vi.mock("../../../lib/markdownAssets", async (original) => ({ ...await original<typeof import("../../../lib/markdownAssets")>(), readMarkdownImage: vi.fn() }));
vi.mock("../../../lib/explorer", () => ({ localCreateEntry: vi.fn(), explorerCanonicalPath: vi.fn() }));
vi.mock("../../../lib/explorer/openExplorer", () => ({ explorerPathKey: (path: string) => path.replace(/\\/g, "/") }));
vi.mock("../../../lib/runtime", () => ({ isTauriRuntime: vi.fn(() => true) }));
vi.mock("../../../lib/sftp", () => ({ sftpMkdir: vi.fn() }));
vi.mock("../../../lib/ipc", () => ({ selectSaveDirectory: vi.fn(), selectSaveFilePath: vi.fn(), writeStreamAbort: vi.fn(), writeStreamAppend: vi.fn(), writeStreamClose: vi.fn(), writeStreamOpen: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  vi.mocked(readMarkdownImage).mockResolvedValue("data:image/png;base64,AQID");
  vi.mocked(writeStreamOpen).mockResolvedValue("stream");
  vi.mocked(writeStreamAppend).mockResolvedValue();
  vi.mocked(writeStreamClose).mockResolvedValue();
  vi.mocked(localCreateEntry).mockResolvedValue("/exports/document (1)");
  vi.mocked(selectSaveDirectory).mockResolvedValue("/exports");
  vi.mocked(selectSaveFilePath).mockResolvedValue("/exports/document.html");
  vi.mocked(explorerCanonicalPath).mockImplementation(async (path) => path);
});

describe("actual Markdown folder and native stream export", () => {
  it("discovers inline/reference images without treating code as an image", () => {
    const content = "![a](assets/a.png)\n\n`![fake](not.png)`\n\n```md\n![fake](also-not.png)\n```\n\n![b][pic]\n\n[pic]: assets/b.png\n";
    const images = markdownImageReferences(content);
    expect(images.map((image) => image.href)).toEqual(["assets/a.png", "assets/b.png"]);
    expect(images.map((image) => content.slice(image.from, image.to))).toEqual(["![a](assets/a.png)", "![b][pic]"]);
  });
  it("rewrites only image nodes, resolves local files, deduplicates attachments and preserves input", async () => {
    const content = "# Doc\n\n![a](assets/a.png)\n\n![b][pic]\n\n[pic]: assets/a.png\n\n`![a](assets/a.png)`\n";
    const plan = await planMarkdownFolder(content, "/docs/document.md");
    expect(plan.files).toEqual([{ name: "image-1.png", bytes: Uint8Array.of(1, 2, 3) }]);
    expect(plan.content.match(/assets\/image-1.png/g)).toHaveLength(2);
    expect(plan.content).toContain("`![a](assets/a.png)`");
    expect(readMarkdownImage).toHaveBeenCalledTimes(1);
    expect(content).toContain("![b][pic]");
  });
  it("does not start folder publication when an image is unreadable or remote", async () => {
    await expect(exportMarkdownFolder("![remote](https://example.test/a.png)", "/docs/document.md")).rejects.toThrow("Remote image");
    expect(localCreateEntry).not.toHaveBeenCalled();
    vi.mocked(readMarkdownImage).mockRejectedValue(new Error("not found"));
    await expect(exportMarkdownFolder("![local](assets/a.png)", "/docs/document.md")).rejects.toThrow("not found");
    expect(localCreateEntry).not.toHaveBeenCalled();
  });
  it("creates a fresh numbered folder, writes assets first and Markdown last", async () => {
    const path = await exportMarkdownFolder("![a](assets/a.png)", "/docs/document.md");
    expect(path).toBe("/exports/document (1)");
    expect(localCreateEntry).toHaveBeenCalledWith("/exports", "document", true);
    expect(sftpMkdir).toHaveBeenCalledWith("", "/exports/document (1)/assets", "local");
    expect(vi.mocked(writeStreamOpen).mock.calls.map(([path]) => path)).toEqual(["/exports/document (1)/assets/image-1.png", "/exports/document (1)/document.md"]);
  });
  it("aborts failed writes and exposes partial output folder, never false success", async () => {
    vi.mocked(writeStreamAppend).mockRejectedValue(new Error("disk full"));
    await expect(exportMarkdownFolder("![a](assets/a.png)", "/docs/document.md")).rejects.toThrow("partial output is retained at /exports/document (1)");
    expect(writeStreamAbort).toHaveBeenCalledWith("stream");
    expect(writeStreamClose).not.toHaveBeenCalled();
  });
  it("handles native picker cancellation without opening a stream", async () => {
    vi.mocked(selectSaveDirectory).mockResolvedValue(null);
    expect(await exportMarkdownFolder("# Doc", "/docs/document.md")).toBeNull();
    vi.mocked(selectSaveFilePath).mockResolvedValue(null);
    expect(await saveExportBlob("document.html", new Blob(["HTML"]), "/docs/document.md")).toBeNull();
    expect(writeStreamOpen).not.toHaveBeenCalled();
  });
  it("rejects source and symlink aliases before opening a truncating native stream", async () => {
    vi.mocked(selectSaveFilePath).mockResolvedValue("/docs/document.md");
    await expect(saveExportBlob("document.html", new Blob(["HTML"]), "/docs/document.md")).rejects.toThrow("source is never overwritten");
    vi.mocked(selectSaveFilePath).mockResolvedValue("/exports/alias.md");
    vi.mocked(explorerCanonicalPath).mockResolvedValue("/docs/document.md");
    await expect(saveExportBlob("document.html", new Blob(["HTML"]), "/docs/document.md")).rejects.toThrow("source is never overwritten");
    expect(writeStreamOpen).not.toHaveBeenCalled();
  });
  it("chunks actual output and closes only after every byte was appended", async () => {
    const bytes = new Uint8Array(600_000).fill(7);
    await writeExportBytes("/exports/test.bin", bytes);
    expect(vi.mocked(writeStreamAppend).mock.calls.map(([, chunk]) => chunk.length)).toEqual([262144, 262144, 75712]);
    expect(writeStreamClose).toHaveBeenCalledWith("stream");
  });
});
