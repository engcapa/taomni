import { describe, expect, it, vi } from "vitest";
import { subscribeClipboardWrites } from "./clipboardOwnership";
import { writeFiles, writeText } from "./clipboard";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
describe("in-window clipboard ownership invalidation", () => {
  it("notifies only after an actual helper write succeeds and releases subscriptions", async () => {
    const written = vi.fn();
    const stop = subscribeClipboardWrites(written);
    try {
      let complete!: () => void;
      invoke.mockReturnValueOnce(new Promise<void>((resolve) => { complete = resolve; }));
      const pending = writeText("/project/other.txt");
      expect(written).not.toHaveBeenCalled();
      complete();
      await pending;
      expect(written).toHaveBeenCalledTimes(1);
      invoke.mockResolvedValueOnce(undefined);
      await writeFiles(["/project/file.bin"]);
      expect(written).toHaveBeenCalledTimes(2);
      invoke.mockRejectedValueOnce(new Error("file-list write denied"));
      await expect(writeFiles(["/project/file.bin"])).rejects.toThrow();
      expect(written).toHaveBeenCalledTimes(2);
      stop();
      invoke.mockResolvedValueOnce(undefined);
      await writeText("later");
      expect(written).toHaveBeenCalledTimes(2);
    } finally { stop(); }
  });
});
