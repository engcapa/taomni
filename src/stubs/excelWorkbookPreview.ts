const FIXTURE_KEY = "taomni.preview.taoffice-excel.workbook.v1";

interface Cell { row: number; column: number; value: string; formula?: string }
interface Sheet { rows: number; columns: number; cells: Cell[] }
interface Fixture { hash: string; sheets: Record<string, Sheet> }
interface Edit { sheet: string; address: string; value: string }
interface Transfer { bytes: Uint8Array; offset: number; sheets?: Fixture["sheets"] }

const transfers = new Map<string, Transfer>();

/** Serve the browser fixture's cell model only after the renderer transfers the actual fixture bytes. */
export async function invokeExcelPreview(command: string, payload: unknown) {
  const { id, size, offset, data, sheet, row, column, edits = [] } = payload as {
    id: string; size: number; offset: number; data: string; sheet: string; row: number; column: number; edits?: Edit[];
  };
  if (command === "workbook/close") {
    transfers.delete(id);
    return null;
  }
  if (command === "workbook/begin") {
    if (!Number.isSafeInteger(size) || size <= 0 || size > 16 * 1024 * 1024) throw new Error("Invalid workbook size");
    transfers.set(id, { bytes: new Uint8Array(size), offset: 0 });
    return null;
  }
  const transfer = transfers.get(id);
  if (!transfer) throw new Error("Excel preview session expired");
  switch (command) {
    case "workbook/append": {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      if (offset !== transfer.offset || offset + bytes.length > transfer.bytes.length) throw new Error("Invalid workbook block");
      transfer.bytes.set(bytes, offset);
      transfer.offset += bytes.length;
      return null;
    }
    case "workbook/open": {
      const fixture = JSON.parse(localStorage.getItem(FIXTURE_KEY) ?? "null") as Fixture | null;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(transfer.bytes)));
      const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (!fixture || transfer.offset !== transfer.bytes.length || fixture.hash !== hash) {
        throw new Error("The browser fixture could not open this workbook");
      }
      transfer.sheets = fixture.sheets;
      return { sheets: Object.keys(fixture.sheets) };
    }
    case "workbook/sheet": {
      const current = transfer.sheets?.[sheet];
      if (!current) throw new Error("Worksheet is unavailable");
      const cells = current.cells.filter((cell) => cell.row >= row && cell.row < row + 32 &&
        cell.column >= column && cell.column < column + 12);
      if (!edits.length) return { ...current, cells };
      // Browser fixtures model the two sample workbooks. The desktop module runs IronCalc.
      const quantity = (index: number) => Number(edits.find((edit) => edit.sheet === "Totals" &&
        edit.address === "B" + (index + 1))?.value ??
        transfer.sheets?.Totals.cells.find((cell) => cell.row === index && cell.column === 1)?.value);
      const total = (quantity(1) + quantity(2)) * 2;
      const values: Record<string, string> = {
        "B2*2": String(quantity(1) * 2), "B3*2": String(quantity(2) * 2),
        "SUM(Totals!C2:C3)": String(total), 'IF(D2>40,"Review","Ready")': total > 40 ? "Review" : "Ready",
      };
      return { ...current, recalculated: true, cells: cells.map((cell) => cell.formula && cell.formula in values
        ? { ...cell, value: values[cell.formula] } : cell) };
    }
    default: throw new Error("Workbook command is unavailable");
  }
}
