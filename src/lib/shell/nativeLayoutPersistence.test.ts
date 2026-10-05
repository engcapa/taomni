import { describe, expect, it, vi } from "vitest";
import { NativeLayoutPersistence } from "./nativeLayoutPersistence";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("Acknowledged desktop layout persistence", () => {
  it("serializes writes and waits for the last acknowledgment", async () => {
    const first = deferred(), calls: Array<[string, string | null]> = [];
    const disk = new NativeLayoutPersistence(async () => "old", async (value, expected) => {
      calls.push([value, expected]);
      if (value === "200") await first.promise;
    });
    await disk.load();
    const a = disk.save("200"), b = disk.save("232");
    await vi.waitFor(() => expect(calls).toEqual([["200", "old"]]));
    let finished = false;
    void disk.settled().then(() => { finished = true; });
    expect(finished).toBe(false);
    first.resolve();
    await Promise.all([a, b, disk.settled()]);
    expect(calls).toEqual([["200", "old"], ["232", "200"]]);
    expect(finished).toBe(true);
  });

  it("retries a failed write against the last acknowledged value", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue(undefined);
    const disk = new NativeLayoutPersistence(async () => "old", write);
    await expect(disk.save("232")).rejects.toThrow("Disk full");
    await disk.save("232");
    expect(write.mock.calls).toEqual([["232", "old"], ["232", "old"]]);
    await disk.save("232");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("never silently replaces an external update, and rereads only for explicit Reset", async () => {
    let stored = "old";
    const write = vi.fn(async (value: string, expected: string | null) => {
      if (stored !== expected) throw new Error("SHELL_LAYOUT_CHANGED");
      stored = value;
    });
    const disk = new NativeLayoutPersistence(async () => stored, write);
    await disk.load(); stored = "future";
    await expect(disk.save("232")).rejects.toThrow("SHELL_LAYOUT_CHANGED");
    await expect(disk.save("248")).rejects.toThrow("SHELL_LAYOUT_CHANGED");
    expect(stored).toBe("future");
    await disk.save("248", true);
    expect(stored).toBe("248");
    expect(write.mock.calls.at(-1)).toEqual(["248", "future"]);
  });

  it("shares a pending load and allows retrying a failed read", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("Busy")).mockResolvedValue(null);
    const disk = new NativeLayoutPersistence(read, vi.fn());
    const first = disk.load();
    expect(disk.load()).toBe(first);
    await expect(first).rejects.toThrow("Busy");
    expect(await disk.load()).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
