import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceImportResult } from "../lib/editor/workspace/importing";

const memory = vi.hoisted(() => new Map<string, Uint8Array | null>());
vi.mock("./localVfs", () => ({
  VFS_ROOT: "/preview",
  vfsStat: vi.fn(async (path: string) => {
    if (!memory.has(path)) throw new Error(`Not found: ${path}`);
    const data = memory.get(path);
    return { path, name: path.split("/").at(-1), fileType: data === null ? "dir" : "file", size: data?.length ?? 0, mtime: 1, isHidden: false };
  }),
  vfsReadBytes: vi.fn(async (path: string) => Uint8Array.from(memory.get(path)!).buffer),
  vfsWriteBytes: vi.fn(async (path: string, bytes: ArrayBuffer) => { memory.set(path, new Uint8Array(bytes)); }),
  vfsRename: vi.fn(async (from: string, to: string) => { memory.set(to, memory.get(from)!); memory.delete(from); }),
  vfsRemove: vi.fn(async (path: string) => { memory.delete(path); }),
}));
import { invoke } from "./tauri-core";

beforeEach(() => {
  memory.clear();
  memory.set("/preview/two", null);
  memory.set("/outside/binary.bin", new Uint8Array([0, 255, 128, 1]));
});

describe("browser import IPC registry", () => {
  it("routes through the real top-level invoke registry and workspace dispatcher", async () => {
    const result = await invoke<WorkspaceImportResult>("workspace_import_paths", {
      repoRoot: "/preview/two", directory: "", sourcePaths: ["/outside/binary.bin"],
    });
    expect(result.failures).toEqual([]);
    expect(result.imported).toMatchObject([{ path: "binary.bin", fileType: "file", size: 4 }]);
    expect(memory.get("/preview/two/binary.bin")).toEqual(new Uint8Array([0, 255, 128, 1]));
    expect(memory.get("/outside/binary.bin")).toEqual(new Uint8Array([0, 255, 128, 1]));
  });

  it("propagates import failures rather than returning an unknown-command payload", async () => {
    memory.set("/preview/two/binary.bin", new Uint8Array([10]));
    await expect(invoke("workspace_import_paths", {
      repoRoot: "/preview/two", directory: "", sourcePaths: ["/outside/binary.bin"],
    })).rejects.toThrow("Path already exists");
    expect(memory.get("/preview/two/binary.bin")).toEqual(new Uint8Array([10]));
  });
});
