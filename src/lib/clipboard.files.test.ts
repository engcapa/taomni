import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFiles, readFilesResult, writeFiles } from "./clipboard";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
describe("strict native file clipboard client", () => {
  it("retains native exact paths, including directory and Unicode whitespace", async () => {
    const paths = ["/outside/ 中文 /name ", "C:\\external\\目录"];
    invoke.mockResolvedValue(paths);
    await expect(readFilesResult()).resolves.toEqual({ ok: true, paths });
    expect(invoke).toHaveBeenCalledWith("clipboard_read_files");
    await writeFiles(paths);
    expect(invoke).toHaveBeenLastCalledWith("clipboard_write_files", { paths });
  });
  it("distinguishes an empty offer from read failure while the legacy helper stays best effort", async () => {
    invoke.mockResolvedValueOnce([]).mockRejectedValueOnce("clipboard_files:permission_denied: refused").mockRejectedValueOnce("refused");
    await expect(readFilesResult()).resolves.toEqual({ ok: true, paths: [] });
    await expect(readFilesResult()).resolves.toEqual({ ok: false, message: "clipboard_files:permission_denied: refused" });
    await expect(readFiles()).resolves.toEqual([]);
  });
  it.each([undefined, null, "file:///outside", [null], [""]])("does not treat malformed native payload %j as successful empty", async (value) => {
    invoke.mockResolvedValueOnce(value);
    await expect(readFilesResult()).resolves.toEqual({ ok: false, message: "Native file clipboard returned an invalid payload" });
  });
  it("propagates file writer failures without trying text or browser clipboard fallback", async () => {
    invoke.mockRejectedValueOnce(new Error("file list denied"));
    await expect(writeFiles(["/outside/note"])).rejects.toThrow("file list denied");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("clipboard_write_files", { paths: ["/outside/note"] });
  });
});
