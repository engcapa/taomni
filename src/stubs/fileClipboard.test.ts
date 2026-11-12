import { beforeEach, describe, expect, it } from "vitest";
import { invoke } from "./tauri-core";
import { clearFiles, readFiles, writeFiles } from "./fileClipboard";
beforeEach(clearFiles);
describe("browser VFS file clipboard", () => {
  it("routes real preview file IPC through the registry without host access", async () => {
    const paths = ["/preview/中文 name.bin", "/preview/dir"];
    await invoke("clipboard_write_files", { paths });
    await expect(invoke("clipboard_read_files")).resolves.toEqual(paths);
  });
  it("does not retain stale paths after clear or leak a mutable list", () => {
    writeFiles(["/preview/one"]);
    readFiles().push("/preview/two");
    expect(readFiles()).toEqual(["/preview/one"]);
    clearFiles();
    expect(readFiles()).toEqual([]);
  });
  it("rejects invalid file lists instead of fabricating browser success", () => {
    expect(() => writeFiles(["relative"])).toThrow();
    expect(() => writeFiles(Array(257).fill("/preview/file"))).toThrow();
  });
});
