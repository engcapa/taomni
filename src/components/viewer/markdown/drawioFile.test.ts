import { beforeEach, expect, it, vi } from "vitest";
import { readStreamClose, readStreamOpen, readStreamRead } from "../../../lib/ipc";
import { DRAWIO_MAX_BYTES } from "./drawioCodec";
import { readDrawioFile } from "./drawioFile";

vi.mock("../../../lib/ipc", () => ({ readStreamOpen: vi.fn(), readStreamRead: vi.fn(), readStreamClose: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readStreamOpen).mockResolvedValue({ handleId: "selected-file", size: 40, mtime: 1 });
  vi.mocked(readStreamClose).mockResolvedValue();
});

it("preserves Unicode split across disk chunks and closes the selected file", async () => {
  const text = "<mxfile>中文😀</mxfile>", bytes = new TextEncoder().encode(text);
  vi.mocked(readStreamRead).mockResolvedValueOnce(bytes.slice(0, 10)).mockResolvedValueOnce(bytes.slice(10)).mockResolvedValueOnce(new Uint8Array());
  await expect(readDrawioFile("/chosen/diagram.drawio", () => true)).resolves.toBe(text);
  expect(readStreamOpen).toHaveBeenCalledWith("/chosen/diagram.drawio");
  expect(readStreamClose).toHaveBeenCalledExactlyOnceWith("selected-file");
});

it("rejects oversized files before reading their contents", async () => {
  vi.mocked(readStreamOpen).mockResolvedValue({ handleId: "large", size: DRAWIO_MAX_BYTES + 1, mtime: 1 });
  await expect(readDrawioFile("/large.drawio", () => true)).rejects.toThrow("20 MB");
  expect(readStreamRead).not.toHaveBeenCalled();
  expect(readStreamClose).toHaveBeenCalledExactlyOnceWith("large");
});

it("rejects a file growing beyond the limit after it was opened", async () => {
  vi.mocked(readStreamRead).mockResolvedValueOnce(new Uint8Array(DRAWIO_MAX_BYTES)).mockResolvedValueOnce(new Uint8Array(1));
  await expect(readDrawioFile("/growing.drawio", () => true)).rejects.toThrow("20 MB");
  expect(readStreamRead).toHaveBeenLastCalledWith("selected-file", 1);
  expect(readStreamClose).toHaveBeenCalledOnce();
});

it("closes a file after an IPC read failure", async () => {
  vi.mocked(readStreamRead).mockRejectedValue(new Error("Disk read failed"));
  await expect(readDrawioFile("/failed.drawio", () => true)).rejects.toThrow("Disk read failed");
  expect(readStreamClose).toHaveBeenCalledOnce();
});

it("stops reading and closes the file when its editor is gone", async () => {
  let active = true;
  vi.mocked(readStreamRead).mockImplementationOnce(async () => { active = false; return new TextEncoder().encode("late data"); });
  await expect(readDrawioFile("/late.drawio", () => active)).resolves.toBeNull();
  expect(readStreamRead).toHaveBeenCalledOnce();
  expect(readStreamClose).toHaveBeenCalledOnce();
});
