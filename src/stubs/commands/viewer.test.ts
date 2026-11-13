import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeViewer } from "./viewer";
import { sha256Bytes } from "./workspace/encoding";
const files = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("../localVfs", () => ({
  VFS_ROOT: "/preview", parentOf: (path: string) => path.slice(0, path.lastIndexOf("/")),
  vfsStat: vi.fn(async (path: string) => { const bytes = files.get(path); if (!bytes) throw new Error("Not found"); return { path, size: bytes.length, mtime: 1, fileType: "file" }; }),
  vfsReadBytes: vi.fn(async (path: string) => { const bytes = files.get(path); if (!bytes) throw new Error("Not a file"); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }),
  vfsWriteBytes: vi.fn(async (path: string, bytes: ArrayBuffer) => { files.set(path, new Uint8Array(bytes)); }),
  vfsMkdir: vi.fn(async (path: string) => { files.set(path, new Uint8Array()); }),
  vfsRemove: vi.fn(async (path: string) => { for (const candidate of files.keys()) if (candidate === path || candidate.startsWith(`${path}/`)) files.delete(candidate); }),
}));
beforeEach(() => { files.clear(); files.set("/preview", new Uint8Array()); vi.clearAllMocks(); });
describe("browser viewer command contract", () => {
  it("checks full hash and preserves encoding/BOM/EOL on saving", async () => {
    files.set("/preview/file.txt", new TextEncoder().encode("old\r\n"));
    const initial = await invokeViewer("viewer_read_text", { path: "/preview/file.txt" }) as { hash: string; eol: string };
    expect(initial.eol).toBe("CRLF");
    await expect(invokeViewer("viewer_write_text", { path: "/preview/file.txt", content: "mine", expectedHash: "stale" })).rejects.toThrow("conflict");
    await invokeViewer("viewer_write_text", { path: "/preview/file.txt", content: "mine\n", expectedHash: initial.hash, eol: "CRLF", encoding: "UTF-16LE", bom: true });
    expect(Array.from(files.get("/preview/file.txt")!.slice(0, 2))).toEqual([255, 254]);
    const saved = await invokeViewer("viewer_read_text", { path: "/preview/file.txt" }) as { content: string; encoding: string };
    expect(saved).toMatchObject({ content: "mine\r\n", encoding: "UTF-16LE" });
  });
  it("never returns an editable prefix hash and exposes exact byte continuation offset", async () => {
    files.set("/preview/file.txt", new TextEncoder().encode("ab中文"));
    const prefix = await invokeViewer("viewer_read_text", { path: "/preview/file.txt", maxBytes: 4 }) as { content: string; nextOffset: number; truncated: boolean; hash: string };
    expect(prefix).toMatchObject({ content: "ab", nextOffset: 2, truncated: true, hash: "" });
    const chunk = await invokeViewer("viewer_read_text_chunk", { path: "/preview/file.txt", offset: prefix.nextOffset, maxBytes: 6 });
    expect(chunk).toMatchObject({ content: "中文", nextOffset: 8, eof: true });
  });
  it("allocates only registered temps and refuses writes before final release", async () => {
    const temp = await invokeViewer("viewer_create_temp", { fileName: "attachment.txt", bytes: [65] }) as { path: string };
    expect(files.get(temp.path)).toEqual(new Uint8Array([65]));
    await expect(invokeViewer("viewer_write_text", { path: temp.path, content: "B", encoding: "UTF-8", expectedHash: await sha256Bytes(new Uint8Array([65])) })).rejects.toThrow("read-only");
    await invokeViewer("viewer_release_temp", { path: temp.path });
    expect(files.has(temp.path)).toBe(false);
    files.set("/preview/user.txt", new Uint8Array([66]));
    await invokeViewer("viewer_release_temp", { path: "/preview/user.txt" });
    expect(files.has("/preview/user.txt")).toBe(true);
  });
  it("encodes pasted-image link segments once and rejects directory traversal", async () => {
    files.set("/preview/document.md", new Uint8Array());
    const image = await invokeViewer("viewer_save_pasted_image", { docPath: "/preview/document.md", dir: "图片 空格", fileName: "50%.png", bytes: [137, 80, 78, 71] }) as { relativePath: string };
    expect(image.relativePath).toBe("%E5%9B%BE%E7%89%87%20%E7%A9%BA%E6%A0%BC/50%25.png");
    await expect(invokeViewer("viewer_save_pasted_image", { docPath: "/preview/document.md", dir: "../outside", fileName: "a.png", bytes: [] })).rejects.toThrow("permission");
  });
});
