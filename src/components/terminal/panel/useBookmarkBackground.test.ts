import { beforeEach, expect, it, vi } from "vitest";
import { loadBookmarkImage } from "./useBookmarkBackground";
const io = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn(), close: vi.fn() }));
vi.mock("../../../lib/ipc/files", () => ({ readStreamOpen: io.open, readStreamRead: io.read, readStreamClose: io.close }));
beforeEach(() => {
  vi.clearAllMocks(); io.open.mockResolvedValue({ handleId: "owned", size: 2 });
  io.close.mockResolvedValue(undefined);
  URL.createObjectURL = vi.fn(() => "blob:owned");
});
it("blocks external and active-content backgrounds before opening any file", async () => {
  for (const path of ["https://example.test/bg.png", "file:///etc/bg.png", "/tmp/active.svg"]) {
    await expect(loadBookmarkImage(path, () => false)).rejects.toThrow("local");
  }
  expect(io.open).not.toHaveBeenCalled();
});
it("closes oversized and cancelled streams without publishing a URL", async () => {
  io.open.mockResolvedValueOnce({ handleId: "owned", size: 9 * 1024 * 1024 });
  await expect(loadBookmarkImage("/tmp/large.png", () => false)).rejects.toThrow("8 MiB");
  expect(io.close).toHaveBeenCalledWith("owned"); expect(io.read).not.toHaveBeenCalled();
  expect(await loadBookmarkImage("/tmp/a.png", () => true)).toBeNull();
  expect(io.close).toHaveBeenCalledTimes(2); expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it("closes streams on read failure and successful complete reads", async () => {
  io.read.mockRejectedValueOnce(new Error("disk failed"));
  await expect(loadBookmarkImage("/tmp/a.png", () => false)).rejects.toThrow("disk failed");
  expect(io.close).toHaveBeenCalledTimes(1);
  io.read.mockResolvedValueOnce(new Uint8Array([1, 2])).mockResolvedValueOnce(new Uint8Array());
  expect(await loadBookmarkImage("/tmp/a.png", () => false)).toBe("blob:owned");
  expect(io.close).toHaveBeenCalledTimes(2);
});
