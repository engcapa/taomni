import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, Uint8Array>());

vi.mock("../../stubs/localVfs", () => ({
  VFS_ROOT: "/preview",
  parentOf: (p: string) => {
    const idx = p.lastIndexOf("/");
    return idx <= 0 ? "" : p.slice(0, idx);
  },
  basenameOf: (p: string) => {
    const idx = p.lastIndexOf("/");
    return idx < 0 ? p : p.slice(idx + 1);
  },
  vfsStat: vi.fn(async (p: string) => {
    const bytes = files.get(p);
    if (!bytes) throw new Error(`Not found: ${p}`);
    return { path: p, size: bytes.length, mtime: 1, fileType: "file", name: p.split("/").pop() ?? "", mode: 0o644, isHidden: false, symlinkTarget: null, owner: null, group: null };
  }),
  vfsMkdir: vi.fn(async (p: string) => {
    files.set(p, new Uint8Array());
  }),
  vfsList: vi.fn(async (dir: string) => {
    const prefix = `${dir}/`;
    const entries = [];
    for (const [p, bytes] of files.entries()) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) {
        entries.push({ path: p, name: p.slice(prefix.length), size: bytes.length, mtime: 1, mode: 0o644, fileType: "file", isHidden: false, symlinkTarget: null, owner: null, group: null });
      }
    }
    return entries;
  }),
  vfsReadBytes: vi.fn(async (p: string) => {
    const bytes = files.get(p);
    if (!bytes) throw new Error(`Not a file: ${p}`);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }),
  vfsWriteBytes: vi.fn(async (p: string, buf: ArrayBuffer) => {
    files.set(p, new Uint8Array(buf));
  }),
  vfsRename: vi.fn(async (oldP: string, newP: string) => {
    const bytes = files.get(oldP);
    if (!bytes) throw new Error(`Not found: ${oldP}`);
    files.set(newP, bytes);
    files.delete(oldP);
  }),
  vfsRemove: vi.fn(async (p: string) => {
    files.delete(p);
  }),
}));

import { invoke } from "../../stubs/tauri-core";
import { stubIsReadonlyPath } from "../../stubs/commands/notepad";

describe("notepad browser IPC stub roundtrips", () => {
  beforeEach(() => {
    localStorage.clear();
    files.clear();
    files.set("/preview", new Uint8Array());
  });

  it("handles viewer_save_as overwrite guard, BOM/EOL, viewer_rename, readonly attr, and viewer_trash", async () => {
    const saved = await invoke<{ path: string; size: number }>("viewer_save_as", {
      path: "/preview/a.txt",
      content: "x\ny",
      encoding: "UTF-8",
      bom: true,
      eol: "CRLF",
      overwrite: false,
    });
    expect(saved.path).toBe("/preview/a.txt");
    expect(Array.from(files.get("/preview/a.txt")!)).toEqual([
      0xef, 0xbb, 0xbf, 0x78, 0x0d, 0x0a, 0x79,
    ]);

    await expect(
      invoke("viewer_save_as", {
        path: "/preview/a.txt",
        content: "z",
        encoding: "UTF-8",
        bom: false,
        eol: "LF",
        overwrite: false,
      }),
    ).rejects.toThrow("exists:");

    const renamed = await invoke<{ newPath: string }>("viewer_rename", {
      oldPath: "/preview/a.txt",
      newName: "b.txt",
    });
    expect(renamed.newPath).toBe("/preview/b.txt");
    expect(files.has("/preview/b.txt")).toBe(true);

    await invoke("viewer_set_readonly_attr", { path: "/preview/b.txt", readonly: true });
    expect(stubIsReadonlyPath("/preview/b.txt")).toBe(true);

    await invoke("viewer_trash", { path: "/preview/b.txt" });
    expect(files.has("/preview/b.txt")).toBe(false);
  });

  it("computes exact MD5/SHA256 hashes, encoding loss, backups, macro tamper state, and sessions", async () => {
    const md5 = await invoke<{ hex: string }>("notepad_hash", { algorithm: "md5", text: "abc" });
    expect(md5.hex).toBe("900150983cd24fb0d6963f7d28e17f72");
    const sha256 = await invoke<{ hex: string }>("notepad_hash", { algorithm: "sha256", text: "abc" });
    expect(sha256.hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    const loss = await invoke<{ unrepresentableCount: number; samples: string[] }>(
      "notepad_check_encoding_loss",
      { content: "Hi 世界", encodingLabel: "windows-1252" },
    );
    expect(loss.unrepresentableCount).toBe(2);
    expect(loss.samples).toEqual(["世", "界"]);

    const entry = await invoke<{ id: string }>("notepad_backup_write", {
      docId: "untitled:1",
      path: null,
      name: "Untitled 1",
      content: "draft",
      encoding: "UTF-8",
      bom: false,
      eol: "LF",
      savedHash: "",
    });
    expect((await invoke<unknown[]>("notepad_backup_list")).length).toBe(1);
    const content = await invoke<{ content: string }>("notepad_backup_read", { id: entry.id });
    expect(content.content).toBe("draft");
    await invoke("notepad_backup_prune", { docId: "untitled:1" });
    expect((await invoke<unknown[]>("notepad_backup_list")).length).toBe(0);

    await invoke("notepad_macros_save", { json: JSON.stringify([{ name: "M", steps: [] }]) });
    localStorage.setItem("taomni.stub.notepad.macros.v1", JSON.stringify([{ name: "Tampered", steps: [] }]));
    const validated = await invoke<{ tampered: boolean }>("notepad_macros_validate");
    expect(validated.tampered).toBe(true);
    const accepted = await invoke<{ tampered: boolean }>("notepad_macros_accept");
    expect(accepted.tampered).toBe(false);

    const sessionPayload = JSON.stringify({ version: 1, activeDocKey: null, tabs: [] });
    await invoke("notepad_session_save", { filePath: null, json: sessionPayload });
    expect(await invoke("notepad_session_load", { filePath: null })).toBe(sessionPayload);
  });
});
