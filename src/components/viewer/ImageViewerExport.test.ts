import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: true, choose: vi.fn(), canonical: vi.fn(), open: vi.fn(), append: vi.fn(), close: vi.fn(), abort: vi.fn(),
}));
vi.mock("../../lib/runtime", () => ({ isTauriRuntime: () => mocks.native }));
vi.mock("../../lib/explorer", () => ({ explorerCanonicalPath: mocks.canonical }));
vi.mock("../../lib/explorer/openExplorer", () => ({ explorerPathKey: (path: string) => path.replace(/\\/g, "/").toLowerCase() }));
vi.mock("../../lib/ipc/files", () => ({
  selectSaveFilePath: mocks.choose, writeStreamOpen: mocks.open, writeStreamAppend: mocks.append,
  writeStreamClose: mocks.close, writeStreamAbort: mocks.abort,
}));
import { saveImageCopy } from "./ImageViewerExport";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.native = true;
  mocks.choose.mockResolvedValue("/exports/copy.png");
  mocks.canonical.mockImplementation(async (path: string) => path);
  mocks.open.mockResolvedValue("handle"); mocks.append.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined); mocks.abort.mockResolvedValue(undefined);
});

describe("image copy/export stream ownership", () => {
  it("cancelled save dialogs do not read or open destination files", async () => {
    mocks.choose.mockResolvedValue(null);
    expect(await saveImageCopy(new Blob(["image"]), "copy.png", "/source/image.png")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.canonical).not.toHaveBeenCalled();
  });

  it("rejects direct source overwrite and symlink aliases before the truncating writer opens", async () => {
    mocks.choose.mockResolvedValue("/exports/source-alias.png");
    mocks.canonical.mockResolvedValue("/source/image.png");
    await expect(saveImageCopy(new Blob(["image"]), "copy.png", "/source/image.png")).rejects.toThrow("source image is never overwritten");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("streams bounded chunks, closes on success and leaves the original untouched", async () => {
    const blob = new Blob([new Uint8Array(600 * 1024)], { type: "image/png" });
    expect(await saveImageCopy(blob, "copy.png", "/source/image.png")).toBe("/exports/copy.png");
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith("/exports/copy.png");
    expect(mocks.append).toHaveBeenCalledTimes(3);
    expect(mocks.append.mock.calls.map((call) => call[1].length)).toEqual([256 * 1024, 256 * 1024, 88 * 1024]);
    expect(mocks.close).toHaveBeenCalledWith("handle");
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  it("aborts the owned destination stream when writing fails", async () => {
    mocks.append.mockRejectedValue(new Error("disk full"));
    await expect(saveImageCopy(new Blob(["image"]), "copy.png", "/source/image.png")).rejects.toThrow("disk full");
    expect(mocks.abort).toHaveBeenCalledWith("handle");
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
