import { describe, expect, it, vi } from "vitest";
import { cellKey, columnName, moveInSheet, openWorkbook, tsv } from "./workbook.js";

describe("Excel workbook renderer", () => {
  it("addresses cells through XFD and clamps keyboard movement at the worksheet edge", () => {
    expect([0, 25, 26, 16_383].map(columnName)).toEqual(["A", "Z", "AA", "XFD"]);
    expect(moveInSheet({ key: "End", metaKey: true }, { row: 1, column: 1 }, { rows: 35, columns: 13 }))
      .toEqual({ row: 34, column: 12 });
    expect(moveInSheet({ key: "ArrowLeft" }, { row: 0, column: 0 }, { rows: 1, columns: 1 }))
      .toEqual({ row: 0, column: 0 });
  });

  it("copies displayed cell values and escapes embedded tabs, line breaks and quotes", () => {
    const cells = new Map([[cellKey(0, 1), { value: 'x"\ny' }], [cellKey(0, 2), { value: "24", formula: "B2*2" }]]);
    expect(tsv(cells, { row: 0, column: 2 }, { row: 0, column: 1 })).toBe('"x""\ny"\t24');
  });

  it("transfers a workbook in bounded parts and cancels before transferring more bytes", async () => {
    const controller = new AbortController();
    const source = { read: async () => new Blob([new Uint8Array(800_000)]) };
    const api = { invoke: vi.fn(async (command) => {
      if (command === "workbook/append") controller.abort();
    }) };
    await expect(openWorkbook(api, source, "id", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(api.invoke.mock.calls.map(([command]) => command)).toEqual(["workbook/begin", "workbook/append"]);
    expect(api.invoke.mock.calls[1][1]).toMatchObject({ id: "id", offset: 0 });
    expect(api.invoke.mock.calls[1][1].data).toHaveLength(1024 * 1024);
  });

  it.each(["XLS", "xlsb", "ods", "xlsx", "xlsm"])("sends the format only for a legacy %s transfer", async (extension) => {
    const api = { invoke: vi.fn(async () => ({ sheets: ["Orders"] })) };
    const source = { extension, read: async () => new Blob(["workbook"]) };
    const signal = new AbortController().signal;
    await expect(openWorkbook(api, source, "id", signal)).resolves.toEqual({ sheets: ["Orders"] });
    const format = extension.length < 4 || extension === "xlsb" ? { format: extension.toLowerCase() } : {};
    expect(api.invoke.mock.calls[0]).toEqual(["workbook/begin", { id: "id", size: 8, ...format }, { signal }]);
    expect(api.invoke.mock.calls.at(-1)).toEqual(["workbook/open", { id: "id" }, { signal }]);
  });
});
