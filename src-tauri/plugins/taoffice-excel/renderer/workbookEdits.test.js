import { describe, expect, it, vi } from "vitest";
import { changedEdits, excelEditKey, workbookCopyBytes } from "./workbookEdits.js";

describe("Excel copy transfer", () => {
  const key = excelEditKey("Totals", "B2");
  const edit = { sheet: "Totals", address: "B2", value: "15.5" };

  it("recognizes the saved snapshot by value", () => {
    const original = new Map([[key, edit]]);
    expect(changedEdits(original, new Map([[key, { ...edit }]]))).toBe(false);
    expect(changedEdits(original, new Map([[key, { ...edit, value: "15" }]]))).toBe(true);
    expect(changedEdits(new Map(), original)).toBe(true);
  });

  it("transfers exact chunk bytes and releases the registered copy", async () => {
    const blockSize = 768 * 1024;
    const cleanup = vi.fn();
    const signal = new AbortController().signal;
    const api = {
      deferCleanup: vi.fn(() => cleanup),
      invoke: vi.fn(async (command, payload) => {
        if (command === "workbook/copy") return { size: blockSize + 1 };
        return { data: btoa(payload.offset === 0 ? "A".repeat(blockSize) : "Z") };
      }),
    };
    const bytes = await workbookCopyBytes(api, "session", new Map([[key, edit]]), signal);
    const { copyId } = api.deferCleanup.mock.calls[0][1];
    expect(api.invoke.mock.calls).toEqual([
      ["workbook/copy", { id: "session", copyId, edits: [edit] }, { signal }],
      ["workbook/copyChunk", { id: "session", copyId, offset: 0 }, { signal }],
      ["workbook/copyChunk", { id: "session", copyId, offset: blockSize }, { signal }],
    ]);
    expect(bytes).toHaveLength(blockSize + 1);
    expect(bytes[blockSize]).toBe(90);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("releases a copy even when the host returns a short block", async () => {
    const cleanup = vi.fn();
    const api = {
      deferCleanup: vi.fn(() => cleanup),
      invoke: vi.fn().mockResolvedValueOnce({ size: 3 }).mockResolvedValueOnce({ data: btoa("AB") }),
    };
    await expect(workbookCopyBytes(api, "session", new Map(), new AbortController().signal))
      .rejects.toThrow("Incomplete workbook copy");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
