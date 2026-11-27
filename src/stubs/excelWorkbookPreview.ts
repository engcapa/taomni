const FIXTURE_KEY = "taomni.preview.taoffice-excel.workbook.v1";

interface Cell { row: number; column: number; value: string; formula?: string }
interface Sheet { rows: number; columns: number; cells: Cell[] }
interface Fixture { hash: string; sheets: Record<string, Sheet> }
interface Transfer { bytes: Uint8Array; offset: number; sheets?: Fixture["sheets"] }

const transfers = new Map<string, Transfer>();

/** Serve the browser fixture's cell model only after the renderer transfers the actual fixture bytes. */
export async function invokeExcelPreview(command: string, payload: unknown) {
  const { id, size, offset, data, sheet, row, column } = payload as {
    id: string; size: number; offset: number; data: string; sheet: string; row: number; column: number;
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
      return { ...current, cells: current.cells.filter((cell) => cell.row >= row && cell.row < row + 32 &&
        cell.column >= column && cell.column < column + 12) };
    }
    default: throw new Error("Workbook command is unavailable");
  }
}
