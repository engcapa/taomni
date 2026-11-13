import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryOperationResult, LocalProperties, PreviewBytes, PreviewText, TrashResult } from "../lib/explorer";
import type { FileEntry } from "../lib/sftp";

const fs = vi.hoisted(() => new Map<string, { directory: boolean; data: ArrayBuffer }>());
vi.mock("./localVfs", () => {
  const stat = async (path: string): Promise<FileEntry> => {
    const record = fs.get(path);
    if (!record) throw new Error(`Not found: ${path}`);
    return { path, name: path.split("/").pop()!, fileType: record.directory ? "dir" : "file", size: record.data.byteLength, mtime: 1, mode: record.directory ? 0o755 : 0o644, isHidden: false };
  };
  return {
    VFS_ROOT: "/preview",
    parentOf: (path: string) => path.slice(0, path.lastIndexOf("/")),
    basenameOf: (path: string) => path.split("/").pop(),
    vfsHome: async () => "/preview",
    vfsStat: stat,
    vfsList: async (path: string) => Promise.all([...fs.keys()].filter((key) => key.slice(0, key.lastIndexOf("/")) === path).map(stat)),
    vfsMkdir: async (path: string) => {
      if (fs.has(path)) throw new Error("Destination exists");
      fs.set(path, { directory: true, data: new ArrayBuffer(0) });
    },
    vfsWriteBytes: async (path: string, data: ArrayBuffer) => { fs.set(path, { directory: false, data }); },
    vfsReadBytes: async (path: string) => {
      const file = fs.get(path);
      if (!file || file.directory) throw new Error("Not a file");
      return file.data;
    },
    vfsRemove: async (path: string) => {
      for (const key of fs.keys()) if (key === path || key.startsWith(path + "/")) fs.delete(key);
    },
    vfsRename: async (from: string, to: string) => {
      if (fs.has(to)) throw new Error("Destination exists");
      if (!fs.has(from)) throw new Error("Not found");
      for (const [path, record] of [...fs]) {
        if (path === from || path.startsWith(from + "/")) {
          fs.set(to + path.slice(from.length), record);
          fs.delete(path);
        }
      }
    },
  };
});
vi.mock("./tauri-event", () => ({ emit: vi.fn(async () => undefined) }));
import { invoke } from "./tauri-core";

function file(path: string, text = "source bytes"): void {
  fs.set(path, { directory: false, data: new TextEncoder().encode(text).buffer });
}
function directory(path: string): void {
  fs.set(path, { directory: true, data: new ArrayBuffer(0) });
}

beforeEach(() => {
  fs.clear();
  localStorage.clear();
  directory("/preview");
  directory("/preview/target");
});

describe("Explorer browser command contracts", () => {
  it("canonicalizes dot segments and rejects nonexistent paths", async () => {
    expect(await invoke("explorer_canonical_path", { path: "/preview/./target/../target/" })).toBe("/preview/target");
    await expect(invoke("explorer_canonical_path", { path: "/preview/missing" })).rejects.toThrow("Not found");
  });

  it("copies recursively including empty folders and generates suffixes without overwriting", async () => {
    directory("/preview/tree.ext");
    directory("/preview/tree.ext/empty");
    file("/preview/tree.ext/notes.txt");
    file("/preview/source.txt");
    const request = { sources: ["/preview/tree.ext", "/preview/source.txt"], destDir: "/preview", conflict: "rename" };
    expect(await invoke<EntryOperationResult>("local_copy_entries", request)).toEqual({
      done: [
        { from: "/preview/tree.ext", to: "/preview/tree.ext - 副本" },
        { from: "/preview/source.txt", to: "/preview/source - 副本.txt" },
      ], failed: [],
    });
    expect(fs.has("/preview/tree.ext - 副本/empty")).toBe(true);
    expect(new TextDecoder().decode(fs.get("/preview/tree.ext - 副本/notes.txt")!.data)).toBe("source bytes");
    const second = await invoke<EntryOperationResult>("local_copy_entries", request);
    expect(second.done.map((entry) => entry.to)).toEqual(["/preview/tree.ext - 副本 (2)", "/preview/source - 副本 (2).txt"]);
    expect(fs.has("/preview/source.txt")).toBe(true);
  });

  it("keeps dotfiles intact and moves only successful entries in a partial batch", async () => {
    file("/preview/.config");
    expect((await invoke<EntryOperationResult>("local_copy_entries", { sources: ["/preview/.config"], destDir: "/preview" })).done[0].to).toBe("/preview/.config - 副本");
    const moved = await invoke<EntryOperationResult>("local_move_entries", { sources: ["/preview/.config", "/preview/missing"], destDir: "/preview/target" });
    expect(moved.done).toEqual([{ from: "/preview/.config", to: "/preview/target/.config" }]);
    expect(moved.failed).toEqual([expect.objectContaining({ path: "/preview/missing", message: expect.stringContaining("Not found") })]);
    expect(fs.has("/preview/.config")).toBe(false);
    expect(fs.has("/preview/target/.config")).toBe(true);
  });

  it("rejects transfer into descendants and treats same-directory moves as no-ops", async () => {
    directory("/preview/tree");
    directory("/preview/tree/nested");
    for (const command of ["local_copy_entries", "local_move_entries"]) {
      const result = await invoke<EntryOperationResult>(command, { sources: ["/preview/tree"], destDir: "/preview/tree/nested" });
      expect(result.done).toEqual([]);
      expect(result.failed[0].message).toContain("descendant");
    }
    file("/preview/source.txt");
    expect((await invoke<EntryOperationResult>("local_move_entries", { sources: ["/preview/source.txt"], destDir: "/preview" })).done).toEqual([{ from: "/preview/source.txt", to: "/preview/source.txt" }]);
  });

  it("returns per-source failure when the destination is not a writable directory", async () => {
    file("/preview/source.txt");
    const result = await invoke<EntryOperationResult>("local_copy_entries", { sources: ["/preview/source.txt"], destDir: "/preview/source.txt" });
    expect(result.failed[0].message).toContain("Not a directory");
    expect(fs.size).toBe(3);
  });

  it("updates partial-cut clipboard only while ownership still matches and clears completed cuts", async () => {
    await invoke("explorer_write_clipboard_files", { paths: ["/preview/a", "/preview/b"], cut: true });
    expect(await invoke("explorer_update_cut_clipboard", { expectedPaths: ["/preview/a", "/preview/b"], remainingPaths: ["/preview/b"] })).toBe(true);
    expect(await invoke("clipboard_read_files")).toEqual(["/preview/b"]);
    await invoke("clipboard_write_files", { paths: ["/preview/external"] });
    expect(await invoke("explorer_update_cut_clipboard", { expectedPaths: ["/preview/b"], remainingPaths: [] })).toBe(false);
    expect(await invoke("clipboard_read_files")).toEqual(["/preview/external"]);
    expect(await invoke("explorer_update_cut_clipboard", { expectedPaths: ["/preview/external"], remainingPaths: [] })).toBe(true);
    expect(await invoke("clipboard_read_files")).toEqual([]);
  });

  it("trashes and restores exact contents, rejecting restore collisions and consumed tokens", async () => {
    directory("/preview/tree");
    file("/preview/tree/notes.txt", "retained original");
    const result = await invoke<TrashResult>("local_trash_entries", { paths: ["/preview/tree", "/preview/missing"] });
    expect(result.trashed).toHaveLength(1);
    expect(result.failed[0].code).toBe("trash_unavailable");
    expect(fs.has("/preview/tree")).toBe(false);
    directory("/preview/tree");
    expect((await invoke<EntryOperationResult>("local_trash_restore", { items: result.trashed })).failed).toHaveLength(1);
    fs.delete("/preview/tree");
    expect((await invoke<EntryOperationResult>("local_trash_restore", { items: result.trashed })).failed).toEqual([]);
    expect(new TextDecoder().decode(fs.get("/preview/tree/notes.txt")!.data)).toBe("retained original");
    expect((await invoke<EntryOperationResult>("local_trash_restore", { items: result.trashed })).failed).toHaveLength(1);
  });

  it("validates portable names, auto-numbers new entries and never replaces a rename destination", async () => {
    for (const name of ["../escape", "CON.txt", "a/b", "trailing.", "bad:name", "..", ""]) {
      await expect(invoke("local_create_entry", { destDir: "/preview", name, directory: false })).rejects.toThrow("Invalid file name");
    }
    expect(await invoke("local_create_entry", { destDir: "/preview", name: "new.txt", directory: false })).toBe("/preview/new.txt");
    expect(await invoke("local_create_entry", { destDir: "/preview", name: "new.txt", directory: false })).toBe("/preview/new (2).txt");
    file("/preview/occupied.txt", "keep");
    await expect(invoke("local_rename_entry", { path: "/preview/new.txt", name: "occupied.txt" })).rejects.toThrow("exists");
    expect(await invoke("local_rename_entry", { path: "/preview/new.txt", name: "renamed.txt" })).toBe("/preview/renamed.txt");
    expect(new TextDecoder().decode(fs.get("/preview/occupied.txt")!.data)).toBe("keep");
  });

  it("limits text reads, marks binary text and enforces image bounds", async () => {
    file("/preview/large.txt", "a".repeat(262_145));
    const text = await invoke<PreviewText>("explorer_read_preview_text", { path: "/preview/large.txt" });
    expect(text).toEqual({ text: "a".repeat(262_144), truncated: true, binary: false });
    file("/preview/binary.txt", "content\0binary");
    expect(await invoke<PreviewText>("explorer_read_preview_text", { path: "/preview/binary.txt" })).toEqual({ text: "", truncated: false, binary: true });
    file("/preview/picture.png", "image");
    expect(await invoke<PreviewBytes>("explorer_read_preview_bytes", { path: "/preview/picture.png" })).toEqual({ bytes: [105, 109, 97, 103, 101], mime: "image/png" });
    await expect(invoke("explorer_read_preview_bytes", { path: "/preview/picture.png", maxBytes: 2 })).rejects.toThrow("too_large");
  });

  it("reports recursive properties and honors pre-existing cancellation without writes", async () => {
    directory("/preview/tree");
    file("/preview/tree/a.txt", "abc");
    directory("/preview/tree/empty");
    expect(await invoke<LocalProperties>("local_properties", { path: "/preview/tree" })).toMatchObject({ name: "tree", fileType: "dir", size: 3, itemCount: 2, truncated: false });
    await invoke("explorer_cancel_operation", { operationId: "cancel-copy" });
    const result = await invoke<EntryOperationResult>("local_copy_entries", { sources: ["/preview/tree"], destDir: "/preview/target", operationId: "cancel-copy" });
    expect(result.failed[0].code).toBe("cancelled");
    expect(fs.has("/preview/target/tree")).toBe(false);
  });
});
