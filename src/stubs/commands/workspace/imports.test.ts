import { beforeEach, describe, expect, it, vi } from "vitest";
import { importStubWorkspacePaths } from "./imports";

const memory = vi.hoisted(() => new Map<string, Uint8Array | null>());
vi.mock("../../localVfs", () => ({
  vfsStat: vi.fn(async (path: string) => {
    if (!memory.has(path)) throw new Error(`Not found: ${path}`);
    const data = memory.get(path);
    return { path, name: path.split("/").at(-1), fileType: data === null ? "dir" : "file", size: data?.length ?? 0, mtime: 1, isHidden: false };
  }),
  vfsList: vi.fn(async (path: string) => [...memory].filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"))
    .map(([path, value]) => ({ path, name: path.split("/").at(-1), fileType: value === null ? "dir" : "file" }))),
  vfsMkdir: vi.fn(async (path: string) => { if (memory.has(path)) throw new Error(`Already exists: ${path}`); memory.set(path, null); }),
  vfsReadBytes: vi.fn(async (path: string) => {
    const data = memory.get(path);
    if (!data) throw new Error(`Not a file: ${path}`);
    return Uint8Array.from(data).buffer;
  }),
  vfsWriteBytes: vi.fn(async (path: string, bytes: ArrayBuffer) => { memory.set(path, new Uint8Array(bytes)); }),
  vfsRename: vi.fn(async (from: string, to: string) => {
    if (memory.has(to)) throw new Error(`Destination exists: ${to}`);
    const rows = [...memory].filter(([key]) => key === from || key.startsWith(`${from}/`));
    for (const [key, bytes] of rows) { memory.set(`${to}${key.slice(from.length)}`, bytes); memory.delete(key); }
  }),
  vfsRemove: vi.fn(async (path: string) => { for (const key of [...memory.keys()]) if (key === path || key.startsWith(`${path}/`)) memory.delete(key); }),
}));

beforeEach(() => {
  memory.clear();
  for (const path of ["/one", "/two", "/two/dest", "/outside", "/outside/bundle", "/outside/bundle/empty"]) memory.set(path, null);
  memory.set("/outside/说明 note.txt", new TextEncoder().encode("outside"));
  memory.set("/outside/bundle/binary.bin", new Uint8Array([0, 255, 128, 2]));
});

describe("browser workspace import stub", () => {
  it("copies recursive bytes into root2 while retaining sources and empty directories", async () => {
    const result = await importStubWorkspacePaths("/two", "dest", ["/outside/说明 note.txt", "/outside/bundle"]);
    expect(result.failures).toEqual([]);
    expect(result.imported.map((entry) => entry.path)).toEqual(["dest/说明 note.txt", "dest/bundle"]);
    expect(memory.get("/two/dest/bundle/binary.bin")).toEqual(new Uint8Array([0, 255, 128, 2]));
    expect(memory.get("/two/dest/bundle/empty")).toBeNull();
    expect(memory.get("/outside/bundle/binary.bin")).toEqual(new Uint8Array([0, 255, 128, 2]));
    expect(memory.has("/one/bundle")).toBe(false);
    expect([...memory.keys()].some((path) => path.includes(".taomni-import-"))).toBe(false);
  });

  it("preflights conflicts without partial writes and retries after a failed import", async () => {
    memory.set("/two/dest/说明 note.txt", new TextEncoder().encode("keep"));
    await expect(importStubWorkspacePaths("/two", "dest", ["/outside/bundle", "/outside/说明 note.txt"])).rejects.toThrow("Path already exists");
    expect(memory.has("/two/dest/bundle")).toBe(false);
    expect(new TextDecoder().decode(memory.get("/two/dest/说明 note.txt")!)).toBe("keep");
    const retried = await importStubWorkspacePaths("/two", "dest", ["/outside/bundle"]);
    expect(retried.imported).toHaveLength(1);
  });

  it("cleans a failed recursive import and reports independent successes", async () => {
    memory.set("/outside/bundle/.git", null);
    const result = await importStubWorkspacePaths("/two", "", ["/outside/bundle", "/outside/说明 note.txt"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toContain(".git");
    expect(result.imported.map((entry) => entry.path)).toEqual(["说明 note.txt"]);
    expect(memory.has("/two/bundle")).toBe(false);
    expect([...memory.keys()].some((path) => path.includes(".taomni-import-"))).toBe(false);
  });

  it.each(["../outside", "/absolute", "C:\\absolute", ".git"])("rejects invalid/protected target %s", async (path) => {
    await expect(importStubWorkspacePaths("/two", path, ["/outside/bundle"])).rejects.toThrow();
    expect(memory.has("/two/bundle")).toBe(false);
  });
});
