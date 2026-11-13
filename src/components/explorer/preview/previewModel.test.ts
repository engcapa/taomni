import { describe, expect, it } from "vitest";
import type { FileEntry } from "../../../lib/sftp";
import {
  CSV_PREVIEW_ROWS,
  IMAGE_PREVIEW_LIMIT,
  parseCsvPreview,
  previewImageBlob,
  previewKind,
  renderOfflineMarkdown,
} from "./previewModel";

function entry(name: string, extra: Partial<FileEntry> = {}): FileEntry {
  return { name, path: `/fixture/${name}`, size: 10, mtime: 1, mode: 0o644, fileType: "file", isHidden: false, ...extra };
}

async function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}

describe("Explorer preview dispatch", () => {
  it.each([
    ["notes.txt", "text"], [".gitignore", "text"], ["Dockerfile", "text"], ["LICENSE", "text"],
    ["README.MD", "markdown"], ["notes.markdown", "markdown"], ["data.CSV", "csv"],
    ["logo.png", "image"], ["vector.svg", "image"], ["binary.bin", "metadata"],
    ["installer.exe", "metadata"], ["document.pdf", "metadata"],
  ])("dispatches %s to %s", (name, kind) => {
    expect(previewKind(entry(name))).toBe(kind);
  });

  it("never reads special files as text or traverses symlink directories", () => {
    expect(previewKind(entry("folder", { fileType: "dir" }))).toBe("directory");
    expect(previewKind(entry("socket.txt", { fileType: "socket" }))).toBe("metadata");
    expect(previewKind(entry("linked", { fileType: "symlink", targetFileType: "dir" }))).toBe("metadata");
    expect(previewKind(entry("linked.txt", { fileType: "symlink", targetFileType: "file" }))).toBe("text");
  });

  it("rejects image reads above 20 MB but text remains previewable above 256 KB", () => {
    expect(previewKind(entry("large.png", { size: IMAGE_PREVIEW_LIMIT + 1 }))).toBe("too-large");
    expect(previewKind(entry("large.png", { size: IMAGE_PREVIEW_LIMIT }))).toBe("image");
    expect(previewKind(entry("large.txt", { size: IMAGE_PREVIEW_LIMIT }))).toBe("text");
  });
});

describe("CSV preview parser", () => {
  it("handles escaped quotes, commas, embedded newlines, CRLF and empty fields", () => {
    expect(parseCsvPreview('id,name,note\r\n1,"Smith, Ada","line 1\nline ""2"""\r\n2,,\r\n').rows).toEqual([
      ["id", "name", "note"], ["1", "Smith, Ada", 'line 1\nline "2"'], ["2", "", ""],
    ]);
  });

  it("renders at most 100 logical records without treating quoted newlines as rows", () => {
    const text = Array.from({ length: 120 }, (_, index) => `${index},"a\nb"`).join("\n");
    const parsed = parseCsvPreview(text);
    expect(parsed.rows).toHaveLength(CSV_PREVIEW_ROWS);
    expect(parsed.rows[99]).toEqual(["99", "a\nb"]);
    expect(parsed.truncated).toBe(true);
  });

  it("retains the final non-newline record and tolerates a truncated quoted field", () => {
    expect(parseCsvPreview('a,b\n1,"unfinished').rows).toEqual([["a", "b"], ["1", "unfinished"]]);
    expect(parseCsvPreview("").rows).toEqual([]);
    expect(parseCsvPreview("a,b\n").truncated).toBe(false);
  });
});

describe("offline preview safety", () => {
  it("reuses Markdown formatting without allowing scripts, image requests or navigation", () => {
    const html = renderOfflineMarkdown('# Title\n\n**strong**\n\n![track](https://tracker.invalid/pixel)\n\n[link](https://example.invalid/)\n\n<script>alert(1)</script><img src="file:///secret" onerror="alert(1)"><iframe src="https://example.invalid"></iframe><p style="background:url(https://tracker.invalid)">safe</p>');
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector("h1")?.textContent).toBe("Title");
    expect(document.querySelector("strong")?.textContent).toBe("strong");
    expect(document.querySelector("script,img,iframe,style,link,svg,math")).toBeNull();
    expect(document.querySelector("[src],[srcset],[href],[style],[onerror]")).toBeNull();
    expect(document.body.textContent).toContain("safe");
  });

  it("keeps image bytes in image-only blobs and rejects non-image MIME types", () => {
    expect(previewImageBlob([1, 2, 3], "image/png").type).toBe("image/png");
    expect(() => previewImageBlob([1], "text/html")).toThrow("Unsupported image format");
  });

  it("sanitizes SVG scripts, external references and URL paint while retaining local gradients", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><style>rect{fill:url(https://tracker.invalid)}</style><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><image href="https://tracker.invalid/pixel"/><use href="file:///secret.svg"/><rect width="10" height="10" fill="url(#g)"/><path fill="url(https://tracker.invalid/external)"/><foreignObject><iframe src="https://tracker.invalid"/></foreignObject></svg>';
    const blob = previewImageBlob(Array.from(new TextEncoder().encode(source)), "image/svg+xml");
    const clean = await blobText(blob);
    expect(clean).toContain("linearGradient");
    expect(clean).toContain("url(#g)");
    expect(clean).not.toMatch(/script|tracker|file:\/\/|foreignObject|<image|<use/);
  });

  it("rejects invalid SVG documents", () => {
    expect(() => previewImageBlob(Array.from(new TextEncoder().encode("not an svg")), "image/svg+xml")).toThrow("Invalid SVG image");
  });
});
